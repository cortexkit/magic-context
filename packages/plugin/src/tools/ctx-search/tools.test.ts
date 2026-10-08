import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory";
import { supersededMemory } from "../../features/magic-context/memory/storage-memory";
import { indexMessagesAfterOrdinal } from "../../features/magic-context/message-index";
import { runMigrations } from "../../features/magic-context/migrations";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import * as searchModule from "../../features/magic-context/search";
import { MAX_UNIFIED_SEARCH_LIMIT } from "../../features/magic-context/search";
import { getOrCreateSessionMeta, queueMemoryMutation } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    injectM0M1,
    materializeM0,
    renderMemoryBlockV2,
} from "../../hooks/magic-context/inject-compartments";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createCtxSearchTools } from "./tools";

const toolContext = (sessionID = "ses-search", directory?: string) =>
    ({ sessionID, directory }) as never;
const EXPAND_HINT =
    "Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.";
const NOTE_EXPAND_HINT =
    "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("createCtxSearchTools", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("validates required query", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute({ query: "   " }, toolContext());

        expect(result).toBe("Error: 'query' is required.");
    });

    it("rejects an invalid date instead of silently searching without it", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "needle", from: "2026-02-30" },
            toolContext(),
        );

        expect(result).toBe("Error: Invalid 'from' date; use YYYY-MM-DD or a full ISO datetime.");
    });

    it("formats empty search results", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute({ query: "missing" }, toolContext());

        expect(result).toBe(
            'No results found for "missing" across notes, memories, primers, git commits, or message history.',
        );
    });

    it("explains when the reporter-shaped memory match set is entirely visible", async () => {
        const matchingIds = new Set([6, 3, 49, 55, 51, 50, 7]);
        for (let id = 1; id <= 55; id += 1) {
            const memory = insertMemory(db, {
                projectPath: "git:reporter",
                category: "ARCHITECTURE",
                content: matchingIds.has(id)
                    ? `Odoo reporter memory ${id}`
                    : `unrelated reporter memory ${id}`,
            });
            expect(memory.id).toBe(id);
        }
        const visibleIds = [3, 4, 54, 5, 7, 49, 53, 6, 50, 51, 52, 55];
        db.prepare("INSERT INTO session_meta (session_id, memory_block_ids) VALUES (?, ?)").run(
            "ses-reporter",
            JSON.stringify(visibleIds),
        );
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "git:reporter",
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "Odoo", sources: ["memory"] },
            toolContext("ses-reporter"),
        );

        expect(result).toBe(
            'No hidden results found for "Odoo".\n\nMemories: 7 matches found, all already visible in your project-memory block (ids 3, 6, 7, 49, 50, 51, 55).',
        );
    });

    it("returns hidden memories and reports additional visible matches", async () => {
        const memories = ["visible one", "visible two", "hidden three"].map((label) =>
            insertMemory(db, {
                projectPath: "git:mixed",
                category: "ARCHITECTURE",
                content: `Aurora ${label}`,
            }),
        );
        db.prepare("INSERT INTO session_meta (session_id, memory_block_ids) VALUES (?, ?)").run(
            "ses-mixed",
            JSON.stringify([memories[0]?.id, memories[1]?.id]),
        );
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "git:mixed",
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "Aurora", sources: ["memory"] },
            toolContext("ses-mixed"),
        );

        expect(result).toContain(`id=${memories[2]?.id}`);
        expect(result).not.toContain(`id=${memories[0]?.id} `);
        expect(result).toContain(
            `Memories: 2 additional matches suppressed because they are already visible in your project-memory block (ids ${memories[0]?.id}, ${memories[1]?.id}).`,
        );
    });

    it("hides a forced m[1] memory using the persisted visible manifest", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-search-m1-"));
        try {
            const projectPath = "git:search-m1";
            const sessionId = "ses-search-m1";
            const original = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: "original memory ".repeat(40),
                importance: 100,
            });
            const replacement = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: "M1SearchToken replacement ".repeat(40),
                importance: 1,
            });
            const options = {
                db,
                sessionId,
                projectPath,
                projectDirectory: dir,
                injectDocs: false,
                memoryInjectionBudgetTokens: estimateTokens(renderMemoryBlockV2([original])) + 2,
            };
            materializeM0({ ...options, state: getOrCreateSessionMeta(db, sessionId) });
            supersededMemory(db, original.id, replacement.id);
            queueMemoryMutation(db, {
                projectPath,
                mutationType: "superseded",
                targetMemoryId: original.id,
                supersededById: replacement.id,
            });
            const refreshed = injectM0M1({
                ...options,
                state: getOrCreateSessionMeta(db, sessionId),
                isCacheBustingPass: true,
            });
            expect(refreshed.m1Text).toContain(`#${replacement.id}: M1SearchToken`);
            const hidden = insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: "M1SearchToken hidden memory",
            });
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => projectPath,
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await tools.ctx_search.execute(
                { query: "M1SearchToken", sources: ["memory"] },
                toolContext(sessionId),
            );
            expect(result).toContain(`id=${hidden.id}`);
            expect(result).not.toContain(`id=${replacement.id} `);
            expect(result).toContain(
                `Memories: 1 additional match suppressed because it is already visible in your project-memory block (ids ${replacement.id}).`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("explains when matching raw messages are still in the live tail", async () => {
        indexMessagesAfterOrdinal(
            db,
            "ses-live-tail",
            [
                {
                    ordinal: 1,
                    id: "live-1",
                    role: "user",
                    parts: [{ type: "text", text: "boundaryneedle first" }],
                },
                {
                    ordinal: 2,
                    id: "live-2",
                    role: "assistant",
                    parts: [{ type: "text", text: "boundaryneedle second" }],
                },
            ],
            0,
            2,
        );
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "git:messages",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "boundaryneedle", sources: ["message"] },
            toolContext("ses-live-tail"),
        );

        expect(result).toBe(
            'No hidden results found for "boundaryneedle".\n\nMessage history: 2 raw-message matches are newer than the last compartment boundary (already in your context).',
        );
    });

    it("explains why commit search is unavailable for a non-repository project", async () => {
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "dir:no-repo",
            memoryEnabled: false,
            embeddingEnabled: false,
            gitCommitsEnabled: true,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "release", sources: ["git_commit"] },
            toolContext("ses-dir", "/tmp/cortexkit-search-no-repo"),
        );

        expect(result).toBe(
            'No hidden results found for "release".\n\nGit commits: no git repository — commit search unavailable for this project.',
        );
    });

    it("treats empty sources and limit 0 as the omitted defaults so required-all filler matches a clean search", async () => {
        const run = async (args: { query: string; sources?: never[]; limit?: number }) => {
            const isolated = createTestDb();
            try {
                for (const [content, label] of [
                    ["Needle alpha", "first"],
                    ["Needle alpha alpha", "second"],
                    ["Needle alpha alpha alpha", "third"],
                ]) {
                    insertMemory(isolated, {
                        projectPath: "/repo/project",
                        category: "ARCHITECTURE",
                        content: `${content} ${label} result.`,
                    });
                }
                const isolatedTools = createCtxSearchTools({
                    db: isolated,
                    resolveProjectPath: () => "/repo/project",
                    memoryEnabled: true,
                    embeddingEnabled: false,
                    readMessages: () => [],
                });
                return await isolatedTools.ctx_search.execute(args, toolContext());
            } finally {
                closeQuietly(isolated);
            }
        };

        const clean = await run({ query: "Needle alpha" });
        const filler = await run({ query: "Needle alpha", sources: [], limit: 0 });

        expect(filler).toBe(clean);
        expect(clean).toContain("Found 3 results");
        expect(clean).toContain("first result");
        expect(clean).toContain("second result");
        expect(clean).toContain("third result");
    });

    // A model-supplied limit is the only bound on the result size, so an
    // unbounded one (limit: 1e6) could dump the archive into a single tool
    // result. The cap matches the Rust module's ctx_search.
    it("caps a huge limit at the maximum result count", async () => {
        const isolated = createTestDb();
        try {
            for (let index = 0; index < 40; index += 1) {
                insertMemory(isolated, {
                    projectPath: "/repo/project",
                    category: "ARCHITECTURE",
                    content: `Needle bravo entry number ${index} result.`,
                });
            }
            const isolatedTools = createCtxSearchTools({
                db: isolated,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });
            const result = await isolatedTools.ctx_search.execute(
                { query: "Needle bravo", sources: ["memory"], limit: 1_000_000 },
                toolContext(),
            );
            expect(result).toContain(`Found ${MAX_UNIFIED_SEARCH_LIMIT} results`);
        } finally {
            closeQuietly(isolated);
        }
    });

    it("formats message results with inline ranges and one trailing expand hint", async () => {
        replaceAllCompartments(db, "ses-message", [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "m1",
                endMessageId: "m10",
                title: "Compartment",
                content: "Summary",
            },
        ]);
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: false,
            embeddingEnabled: false,
            readMessages: () => [
                {
                    ordinal: 5,
                    id: "m5",
                    role: "assistant",
                    parts: [{ type: "text", text: "Alpha migration details are here." }],
                },
                {
                    ordinal: 6,
                    id: "m6",
                    role: "user",
                    parts: [{ type: "text", text: "More alpha migration context." }],
                },
            ],
        });
        indexMessagesAfterOrdinal(
            db,
            "ses-message",
            [
                ...Array.from({ length: 4 }, (_, index) => ({
                    ordinal: index + 1,
                    id: `covered-${index + 1}`,
                    role: "system",
                    parts: [],
                })),
                {
                    ordinal: 5,
                    id: "m5",
                    role: "assistant",
                    parts: [{ type: "text", text: "Alpha migration details are here." }],
                },
                {
                    ordinal: 6,
                    id: "m6",
                    role: "user",
                    parts: [{ type: "text", text: "More alpha migration context." }],
                },
            ],
            0,
            6,
        );

        const result = await tools.ctx_search.execute(
            { query: "alpha migration", sources: ["message"] },
            toolContext("ses-message"),
        );

        expect(result).toContain("[1] [message] score=1.00 ordinal=6 range=3-9 role=user");
        expect(result).toContain("[2] [message] score=0.50 ordinal=5 range=2-8 role=assistant");
        expect(result.split(EXPAND_HINT).length - 1).toBe(1);
        expect(result.endsWith(EXPAND_HINT)).toBe(true);
        expect(result).not.toContain("Expand with ctx_expand(start=");
    });

    it("omits the consolidated expand hint for memory-only results", async () => {
        insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Alpha memory only search result.",
        });
        const tools = createCtxSearchTools({
            db,
            resolveProjectPath: () => "/repo/project",
            memoryEnabled: true,
            embeddingEnabled: false,
            readMessages: () => [],
        });

        const result = await tools.ctx_search.execute(
            { query: "alpha", sources: ["memory"] },
            toolContext(),
        );

        expect(result).toContain("[1] [memory]");
        expect(result).not.toContain(EXPAND_HINT);
        expect(result).not.toContain("ctx_expand");
    });

    it("formats note results with note ids, status labels, and anchor expand hints", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "note",
                        content: "Keep the dry-run fallback until telemetry stabilizes.",
                        score: 0.88,
                        noteId: 7,
                        status: "dismissed",
                        createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
                        anchorOrdinal: 44,
                        sourceSessionId: "ses-search",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute(
                { query: "telemetry fallback", sources: ["note"] },
                toolContext(),
            );

            expect(result).toContain("[1] [note]");
            expect(result).toContain("id=#7 status=dismissed");
            expect(result).toContain("@msg 44");
            expect(result).toContain(NOTE_EXPAND_HINT);
        } finally {
            spy.mockRestore();
        }
    });

    it("omits note anchors and footer hints for foreign-session smart notes", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "note",
                        content: "Foreign session note should not expose an expandable anchor.",
                        score: 0.73,
                        noteId: 8,
                        status: "ready",
                        createdAt: Date.now(),
                        anchorOrdinal: 45,
                        sourceSessionId: "ses-other",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: false,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute(
                { query: "foreign anchor", sources: ["note"] },
                toolContext("ses-search"),
            );

            expect(result).toContain("[1] [note]");
            expect(result).not.toContain("@msg 45");
            expect(result).not.toContain(NOTE_EXPAND_HINT);
        } finally {
            spy.mockRestore();
        }
    });

    it("resolves a `#1234` query directly to the matching memory without calling unifiedSearch", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "ARCHITECTURE_DECISIONS",
            content: "Direct id hit for the short-circuit.",
        });
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async () => {
            throw new Error("unifiedSearch must not run for ID-shaped queries");
        });
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute(
                { query: `#${memory.id}` },
                toolContext(),
            );

            expect(result).toContain("[1] [memory]");
            expect(result).toContain(`id=${memory.id}`);
            expect(result).toContain("Direct id hit for the short-circuit.");
        } finally {
            spy.mockRestore();
        }
    });

    it("falls through to unifiedSearch when the bare-id query has no matching memory", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "memory",
                        content: "Numeric query that survived into text search.",
                        score: 0.5,
                        memoryId: 1,
                        category: "USER_DIRECTIVES",
                        matchType: "fts",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute({ query: "7234" }, toolContext());

            // The id short-circuit found nothing for 7234, so the call must
            // reach the normal text lanes (which we mocked here).
            expect(result).toContain("[1] [memory]");
            expect(result).toContain("Numeric query that survived into text search.");
        } finally {
            spy.mockRestore();
        }
    });

    it("does NOT treat a phrase containing a number as an id lookup", async () => {
        const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
            async () =>
                [
                    {
                        source: "memory",
                        content: "Text search hit, not an id lookup.",
                        score: 0.6,
                        memoryId: 1,
                        category: "USER_DIRECTIVES",
                        matchType: "fts",
                    },
                ] as UnifiedSearchResult[],
        );
        try {
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
            });

            const result = await tools.ctx_search.execute({ query: "fix bug 1234" }, toolContext());

            expect(result).toContain("Text search hit, not an id lookup.");
        } finally {
            spy.mockRestore();
        }
    });
});
