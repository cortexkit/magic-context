import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as autoEmbed from "../../../hooks/magic-context/auto-embed-session";
import * as compartmentRunner from "../../../hooks/magic-context/compartment-runner";
import { createTransform } from "../../../hooks/magic-context/transform";
import { runCompartmentPhase } from "../../../hooks/magic-context/transform-compartment-phase";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { createCtxMemoryTools } from "../../../tools/ctx-memory";
import { createCtxNoteTools } from "../../../tools/ctx-note";
import { createCtxSearchTools } from "../../../tools/ctx-search";
import { createV2AutoEmbedSession } from "../../../v2/hooks/transform-features";
import { runMigrations } from "../migrations";
import * as search from "../search";
import {
    getRecordedSessionProjectIdentity,
    recordSessionProjectIdentity,
} from "../session-project-storage";
import { initializeDatabase } from "../storage-db";
import { readSessionMeta, updateSessionMeta } from "../storage-meta-session";
import { persistCachedM0 } from "../storage-meta-shared";
import { addNote, getNoteByIdInScope, getSessionNotes } from "../storage-notes";
import { writeSessionMetaCollection } from "../storage-session-collections";
import { createTagger } from "../tagger";
import {
    readAppliedProjection,
    readCachedM0OwnerEvidence,
    readMemoryRevisions,
    writeHardProjection,
    writeSoftProjection,
} from "./applied-projection";
import { rememberPinnedProjectIdentity } from "./project-identity-cache";
import {
    __resetSessionIdentityDecisionsForTests,
    awaitSessionIdentityDecision,
    backgroundSessionProjectIdentity,
    readSessionIdentityDecision,
    recoverCachedSessionProjectOwner,
    resolveSessionProjectIdentity,
} from "./session-identity-decision";
import { getMemoriesByProject, getMemoryById, insertMemory } from "./storage-memory";

let db: Database;
let temp: ReturnType<typeof createTestTempDir>;
const cleanups: (() => void)[] = [];
const A = "pj-OWNER-FIXTURE-A";
const B = "pj-OWNER-FIXTURE-B";

beforeEach(() => {
    temp = createTestTempDir("mc-owner-proof-");
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
});

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    __resetSessionIdentityDecisionsForTests();
    db.close();
    temp.cleanup();
});

function hardTuple(
    sessionId: string,
    projectIdentity: string | undefined,
    text: string,
    ids: number[] = [],
    store: Database = db,
) {
    const memories = ids.map((id) => {
        const memory = getMemoryById(store, id);
        if (!memory) throw new Error(`Missing fixture memory ${id}`);
        return memory;
    });
    writeHardProjection(store, {
        sessionId,
        projectPath: projectIdentity,
        m0Text: text,
        hardMemoryBlock: JSON.stringify({ updateLines: [], newMemories: "" }),
        fragmentWatermark: 0,
        revisions: readMemoryRevisions(store, ids),
        textMemories: memories,
        cueMemories: [],
        deltaMemories: [],
    });
}

function commitFrame(
    sessionId: string,
    projectIdentity: string | undefined,
    text: string,
    ids: number[] = [],
    store: Database = db,
) {
    store
        .transaction(() => {
            persistCachedM0(store, sessionId, {
                m0Bytes: Buffer.from(text),
                m1Bytes: Buffer.from("<session-history-since>(none)</session-history-since>"),
                projectIdentity,
                projectMemoryEpoch: 0,
                projectUserProfileVersion: 0,
                maxCompartmentSeq: -1,
                maxMemoryId: Math.max(0, ...ids),
                maxMutationId: 0,
                projectDocsHash: "fixture-docs",
                materializedAt: Date.now(),
                sessionFactsVersion: 0,
                upgradeState: null,
            });
            writeSessionMetaCollection(store, sessionId, "memory_block_ids", JSON.stringify(ids));
            store
                .prepare("UPDATE session_meta SET memory_block_count = ? WHERE session_id = ?")
                .run(ids.length, sessionId);
            hardTuple(sessionId, projectIdentity, text, ids, store);
        })
        .immediate();
}

function toolsFor(sessionId: string) {
    const a = join(temp.dir, "a"),
        b = join(temp.dir, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    rememberPinnedProjectIdentity(a, A);
    rememberPinnedProjectIdentity(b, B);
    const connectionFile = join(temp.dir, "no-connection.json");
    const resolveProjectPath = (directory: string, session: string) =>
        resolveSessionProjectIdentity(session, directory, { db, connectionFile });
    const context = {
        sessionID: sessionId,
        messageID: "u1",
        directory: b,
        worktree: b,
        agent: "build",
        abort: new AbortController().signal,
        metadata: () => {},
    } as never;
    return {
        a,
        b,
        connectionFile,
        context,
        memory: createCtxMemoryTools({
            db,
            resolveProjectPath,
            memoryEnabled: true,
            embeddingEnabled: false,
        }).ctx_memory!,
        note: createCtxNoteTools({
            db,
            resolveProjectPath,
            dreamerEnabled: true,
            smartNotesEnabled: true,
        }).ctx_note!,
        search: createCtxSearchTools({
            db,
            resolveProjectPath,
            memoryEnabled: true,
            embeddingEnabled: false,
            gitCommitsEnabled: true,
        }).ctx_search!,
    };
}

function unprovableFrame(sessionId: string) {
    const alpha = insertMemory(db, {
        projectPath: A,
        category: "USER_DIRECTIVES",
        content: "cached alpha claim",
    });
    const beta = insertMemory(db, {
        projectPath: B,
        category: "USER_DIRECTIVES",
        content: "hidden beta claim",
    });
    const text = `<session-history></session-history>\n\n<project-memory>\n<USER_DIRECTIVES>\n#${alpha.id}: ${alpha.content}\n</USER_DIRECTIVES>\n</project-memory>`;
    commitFrame(sessionId, A, text, [alpha.id]);
    updateSessionMeta(db, sessionId, { cachedM0ProjectIdentity: null });
    db.prepare("DELETE FROM memory_applied_snapshots WHERE session_id = ?").run(sessionId);
    return { alpha, beta, text };
}

describe("legacy owner evidence and cold-upgrade cost", () => {
    test("fixture matrix recovers exact HARD provenance and rejects every unproved candidate", () => {
        const cases = [
            "exact",
            "soft-same",
            "soft-other",
            "absent",
            "legacy-only",
            "wrong-hash",
            "ambiguous",
            "empty-and-owned",
            "empty-only",
            "blank-path",
        ] as const;
        let recovered = 0,
            unprovable = 0,
            ownerTransactions = 0;
        let recoveryMilliseconds = 0,
            bytesExamined = 0;
        for (const scenario of cases) {
            const sessionId = `owner-matrix-${scenario}`;
            const text = `<session-history>${scenario}: ${"baseline summary ".repeat(2048)}</session-history>`;
            commitFrame(
                sessionId,
                scenario === "empty-only" ? undefined : scenario === "blank-path" ? " " : A,
                text,
            );
            recordSessionProjectIdentity(db, sessionId, B);
            updateSessionMeta(db, sessionId, { cachedM0ProjectIdentity: null });
            if (scenario === "absent")
                db.prepare("DELETE FROM memory_applied_snapshots WHERE session_id = ?").run(
                    sessionId,
                );
            if (scenario === "legacy-only")
                db.prepare(
                    "UPDATE memory_applied_snapshots SET legacy = 1 WHERE session_id = ?",
                ).run(sessionId);
            if (scenario === "wrong-hash") hardTuple(sessionId, A, "different baseline");
            if (scenario === "ambiguous") hardTuple(sessionId, B, text);
            if (scenario === "empty-and-owned") hardTuple(sessionId, undefined, text);
            if (scenario === "soft-same" || scenario === "soft-other") {
                const projection = readAppliedProjection(db, sessionId, A, text)!;
                writeSoftProjection(db, {
                    sessionId,
                    projectPath: scenario === "soft-same" ? A : B,
                    m0Text: text,
                    projection:
                        scenario === "soft-same" ? projection : { ...projection, legacy: true },
                });
            }
            const state = readSessionMeta(db, sessionId);
            const before = {
                m0: state.cachedM0Bytes?.toString("hex"),
                m1: state.cachedM1Bytes?.toString("hex"),
                at: state.cachedM0MaterializedAt,
            };
            const transaction = db.transaction.bind(db);
            let transactions = 0;
            const spy = spyOn(db, "transaction").mockImplementation(((
                ...args: Parameters<typeof db.transaction>
            ) => {
                const tx = transaction(...args);
                const immediate = tx.immediate.bind(tx);
                const wrapped = ((...values: unknown[]) => tx(...values)) as typeof tx;
                wrapped.immediate = ((...values: unknown[]) => {
                    transactions++;
                    return immediate(...values);
                }) as typeof tx.immediate;
                wrapped.deferred = tx.deferred.bind(tx);
                wrapped.exclusive = tx.exclusive.bind(tx);
                return wrapped;
            }) as typeof db.transaction);
            const started = performance.now();
            const result = recoverCachedSessionProjectOwner(db, sessionId, state);
            recoveryMilliseconds += performance.now() - started;
            spy.mockRestore();
            ownerTransactions += transactions;
            bytesExamined += state.cachedM0Bytes?.byteLength ?? 0;
            const expected =
                scenario === "exact" || scenario === "soft-same" || scenario === "soft-other";
            expect(result.projectIdentity).toBe(expected ? A : undefined);
            expect(result.recovered).toBe(expected);
            expect(transactions).toBe(expected ? 1 : 0);
            const after = readSessionMeta(db, sessionId);
            expect({
                m0: after.cachedM0Bytes?.toString("hex"),
                m1: after.cachedM1Bytes?.toString("hex"),
                at: after.cachedM0MaterializedAt,
            }).toEqual(before);
            expect(after.cachedM0ProjectIdentity).toBe(expected ? A : null);
            expect(getRecordedSessionProjectIdentity(db, sessionId)).toBe(B);
            if (expected) recovered++;
            else unprovable++;
        }
        expect({ recovered, unprovable, ownerTransactions }).toEqual({
            recovered: 3,
            unprovable: 7,
            ownerTransactions: 3,
        });
        console.log(
            "OWNER_RECOVERY_COST " +
                JSON.stringify({
                    fixtures: cases.length,
                    recovered,
                    unprovable,
                    ownerTransactions,
                    bytesExamined,
                    recoveryMilliseconds,
                }),
        );
    });

    test("malformed UTF-8 cannot match a different valid baseline after lossy decoding", () => {
        const sessionId = "owner-invalid-utf8";
        hardTuple(sessionId, A, "\uFFFD");
        expect(
            readCachedM0OwnerEvidence(db, sessionId, new Uint8Array([0xff])).projectIdentity,
        ).toBeUndefined();
    });
});

describe("unproven owners fail closed without disabling independent tools", () => {
    test("memory reads/writes refuse by name, search caps memory, and session notes stay scoped", async () => {
        const sessionId = "owner-unproven-tools";
        const { alpha, beta } = unprovableFrame(sessionId);
        const tools = toolsFor(sessionId);
        const before = readSessionMeta(db, sessionId).cachedM0Bytes?.toString("hex");
        const write = await tools.memory.execute(
            { action: "write", category: "USER_DIRECTIVES", content: "must not be saved" },
            tools.context,
        );
        expect(write).toContain("ctx_memory write refused");
        expect(write).toContain("verified project owner");
        expect(write).toContain("history rebuild");
        const read = await tools.memory.execute(
            { action: "get", ids: [alpha.id, beta.id] },
            tools.context,
        );
        expect(read).toContain("ctx_memory get refused");
        expect(read).not.toContain(alpha.content);
        expect(read).not.toContain(beta.content);
        expect(getMemoriesByProject(db, A).map((row) => row.content)).not.toContain(
            "must not be saved",
        );
        expect(getMemoriesByProject(db, B).map((row) => row.content)).not.toContain(
            "must not be saved",
        );
        const sessionNote = addNote(db, "session", {
            sessionId,
            content: "session note before update",
        });
        const smartNote = addNote(db, "smart", {
            sessionId,
            projectPath: A,
            content: "hidden project smart note",
            surfaceCondition: "when needed",
        });
        expect(
            getNoteByIdInScope(db, smartNote.id, { sessionId, projectPath: undefined }),
        ).toBeNull();
        const noteRead = await tools.note.execute(
            { action: "read", note_ids: [smartNote.id] },
            tools.context,
        );
        expect(noteRead).toContain("ctx_note read refused");
        expect(noteRead).toContain("history rebuild");
        expect(noteRead).not.toContain(smartNote.content);
        expect(
            await tools.note.execute(
                { action: "update", note_ids: [sessionNote.id], content: "safe session update" },
                tools.context,
            ),
        ).toContain("Updated note");
        expect(
            await tools.note.execute({ action: "read", note_ids: [sessionNote.id] }, tools.context),
        ).toContain("safe session update");
        const ownNote = addNote(db, "session", { sessionId, content: "safe session search note" });
        const searchSpy = spyOn(search, "unifiedSearch").mockResolvedValue([
            {
                source: "memory",
                memoryId: beta.id,
                category: "USER_DIRECTIVES",
                content: beta.content,
                score: 1,
                matchType: "fts",
            },
            {
                source: "primer",
                primerId: 99,
                question: "hidden primer",
                content: "hidden primer answer",
                score: 1,
                support: 1,
                lastObservedAt: null,
                matchType: "fts",
            },
            {
                source: "message",
                content: "safe historical message",
                score: 1,
                messageId: "old-message",
                messageOrdinal: 1,
                role: "user",
            },
            {
                source: "git_commit",
                content: "safe git result",
                score: 1,
                sha: "a".repeat(40),
                shortSha: "aaaaaaa",
                author: null,
                committedAtMs: 1,
                matchType: "fts",
            },
            {
                source: "note",
                noteId: smartNote.id,
                content: smartNote.content,
                score: 1,
                status: "ready",
                createdAt: 1,
                anchorOrdinal: null,
                sourceSessionId: sessionId,
            },
            {
                source: "note",
                noteId: ownNote.id,
                content: ownNote.content,
                score: 1,
                status: "active",
                createdAt: 1,
                anchorOrdinal: null,
                sourceSessionId: sessionId,
            },
        ]);
        cleanups.push(() => searchSpy.mockRestore());
        const result = await tools.search.execute({ query: `#${beta.id}` }, tools.context);
        expect(result).toContain("Memory results are unavailable");
        expect(result).toContain("safe historical message");
        expect(result).toContain("safe git result");
        expect(result).toContain(ownNote.content);
        expect(result).not.toContain(beta.content);
        expect(result).not.toContain(smartNote.content);
        expect(result).not.toContain("hidden primer answer");
        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy.mock.calls[0]?.[4]).toMatchObject({
            memoryEnabled: false,
            chunkPoolWarmOnly: true,
        });
        expect(searchSpy.mock.calls[0]?.[4].sources).not.toContain("memory");
        expect(searchSpy.mock.calls[0]?.[4].sources).not.toContain("primer");
        const memoryOnly = await tools.search.execute(
            { query: "hidden", sources: ["memory"] },
            tools.context,
        );
        expect(memoryOnly).toContain("Memory results are unavailable");
        expect(memoryOnly).not.toContain("Error:");
        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(
            await tools.note.execute(
                { action: "dismiss", note_ids: [sessionNote.id] },
                tools.context,
            ),
        ).toContain("dismissed");
        expect(
            await tools.note.execute(
                { action: "update", note_ids: [smartNote.id], content: "unsafe" },
                tools.context,
            ),
        ).toContain("ctx_note update refused");
        expect(
            await tools.note.execute(
                { action: "dismiss", note_ids: [smartNote.id] },
                tools.context,
            ),
        ).toContain("ctx_note dismiss refused");
        expect(
            await tools.note.execute(
                { action: "write", content: "safe new session note" },
                tools.context,
            ),
        ).not.toContain("refused");
        expect(getSessionNotes(db, sessionId).map((note) => note.content)).toContain(
            "safe new session note",
        );
        expect(readSessionMeta(db, sessionId).cachedM0Bytes?.toString("hex")).toBe(before);
        expect(readSessionMeta(db, sessionId).cachedM0ProjectIdentity).toBeNull();
    });

    test("the same tool definitions resume after the first independently admitted rebuild", async () => {
        const sessionId = "owner-resumes";
        const tools = toolsFor(sessionId);
        const alpha = insertMemory(db, {
            projectPath: A,
            category: "USER_DIRECTIVES",
            content: "old alpha baseline",
        });
        const beta = insertMemory(db, {
            projectPath: B,
            category: "USER_DIRECTIVES",
            content: "new beta baseline",
        });
        const directories = new Map([[sessionId, tools.a]]);
        const deps = {
            db,
            directory: tools.a,
            sessionDirectoryBySession: directories,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" as const },
            contextUsageMap: new Map(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            injectDocs: false,
            subcConnectionFile: tools.connectionFile,
            memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: false },
        };
        const transform = createTransform(deps);
        const messages = () => [
            {
                info: { id: "u1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continue" }],
            },
        ];
        const first = { messages: messages() };
        await transform({}, first);
        expect(JSON.stringify(first.messages)).toContain(alpha.content);
        updateSessionMeta(db, sessionId, { cachedM0ProjectIdentity: null });
        db.prepare("DELETE FROM memory_applied_snapshots WHERE session_id = ?").run(sessionId);
        expect(
            await tools.memory.execute(
                { action: "write", category: "USER_DIRECTIVES", content: "blocked before rebuild" },
                tools.context,
            ),
        ).toContain("ctx_memory write refused");
        directories.set(sessionId, tools.b);
        const deferred = { messages: messages() };
        await transform({}, deferred);
        expect(JSON.stringify(deferred.messages.slice(0, 2))).toBe(
            JSON.stringify(first.messages.slice(0, 2)),
        );
        expect(readSessionMeta(db, sessionId).cachedM0ProjectIdentity).toBeNull();
        updateSessionMeta(db, sessionId, { systemPromptHash: "admitted-new-baseline" });
        const rebuilt = { messages: messages() };
        await transform({}, rebuilt);
        expect(JSON.stringify(rebuilt.messages)).toContain(beta.content);
        expect(readSessionMeta(db, sessionId).cachedM0ProjectIdentity).toBe(B);
        expect(
            await tools.memory.execute({ action: "get", ids: [beta.id] }, tools.context),
        ).toContain(beta.content);
        expect(
            await tools.memory.execute(
                { action: "write", category: "USER_DIRECTIVES", content: "saved after rebuild" },
                tools.context,
            ),
        ).toContain("Saved memory");
        expect(getMemoriesByProject(db, B).map((row) => row.content)).toContain(
            "saved after rebuild",
        );
        expect(getMemoriesByProject(db, A).map((row) => row.content)).not.toContain(
            "blocked before rebuild",
        );
    });
});

describe("history-only background exception", () => {
    const docs =
        "<session-history></session-history>\n\n<project-docs>Example quoted literally: <project-memory>not a generated memory block</project-memory></project-docs>";

    test("memory-off history embeds with empty HARD evidence and count zero even when docs quote memory tags", () => {
        const sessionId = "history-only-docs";
        commitFrame(sessionId, undefined, docs);
        const state = readSessionMeta(db, sessionId);
        expect(state.memoryBlockCount).toBe(0);
        const scheduled = spyOn(autoEmbed, "maybeAutoEmbedSessionBackfill").mockImplementation(
            () => {},
        );
        cleanups.push(() => scheduled.mockRestore());
        const run = createV2AutoEmbedSession(
            { db, resolveDirectory: () => temp.dir, recompProgressBySession: new Map() },
            async () => {},
        );
        const owner = backgroundSessionProjectIdentity(db, sessionId, state, false, B);
        expect(owner).toBe(B);
        run(sessionId, { projectIdentity: owner });
        expect(scheduled).toHaveBeenCalledTimes(1);
        expect(scheduled.mock.calls[0]?.[0].projectIdentity).toBe(B);
        expect(readSessionMeta(db, sessionId).cachedM0ProjectIdentity).toBeNull();
    });

    test("memory-on unprovable frames pause auto-embedding for that session only", () => {
        const sessionId = "memory-on-unproven";
        unprovableFrame(sessionId);
        const scheduled = spyOn(autoEmbed, "maybeAutoEmbedSessionBackfill").mockImplementation(
            () => {},
        );
        cleanups.push(() => scheduled.mockRestore());
        const run = createV2AutoEmbedSession(
            { db, resolveDirectory: () => temp.dir, recompProgressBySession: new Map() },
            async () => {},
        );
        const state = readSessionMeta(db, sessionId);
        expect(backgroundSessionProjectIdentity(db, sessionId, state, true, B)).toBeUndefined();
        run(sessionId, { projectIdentity: undefined });
        expect(scheduled).not.toHaveBeenCalled();
        commitFrame("healthy-background", A, "<session-history>healthy</session-history>");
        const healthy = backgroundSessionProjectIdentity(
            db,
            "healthy-background",
            readSessionMeta(db, "healthy-background"),
            true,
            B,
        );
        expect(healthy).toBe(A);
        run("healthy-background", { projectIdentity: healthy });
        expect(scheduled).toHaveBeenCalledTimes(1);
        expect(scheduled.mock.calls[0]?.[0].projectIdentity).toBe(A);
    });

    test("unknown manifest count is not zero and stays paused until an admitted render commits zero", () => {
        const sessionId = "history-unknown-count";
        commitFrame(sessionId, undefined, docs);
        db.prepare("UPDATE session_meta SET memory_block_count = NULL WHERE session_id = ?").run(
            sessionId,
        );
        const state = readSessionMeta(db, sessionId);
        expect(state.memoryBlockCount).toBeNull();
        expect(
            readCachedM0OwnerEvidence(db, sessionId, state.cachedM0Bytes!).unscopedHardMatch,
        ).toBe(true);
        expect(backgroundSessionProjectIdentity(db, sessionId, state, false, B)).toBeUndefined();
        expect(state.memoryBlockCount).toBeNull();
        commitFrame(sessionId, undefined, docs);
        const committed = readSessionMeta(db, sessionId);
        expect(committed.memoryBlockCount).toBe(0);
        expect(backgroundSessionProjectIdentity(db, sessionId, committed, false, B)).toBe(B);
    });

    test("a missing count column remains unknown through the existing fallback SELECT", () => {
        const file = join(temp.dir, "missing-count.db");
        const old = new Database(file);
        initializeDatabase(old);
        runMigrations(old);
        commitFrame("missing-count", undefined, docs, [], old);
        old.exec("ALTER TABLE session_meta DROP COLUMN memory_block_count");
        old.close();
        const reader = new Database(file);
        try {
            const state = readSessionMeta(reader, "missing-count");
            expect(state.cachedM0Bytes?.toString("utf8")).toBe(docs);
            expect(state.memoryBlockCount).toBeNull();
            expect(
                backgroundSessionProjectIdentity(reader, "missing-count", state, false, B),
            ).toBeUndefined();
            const absent = readSessionMeta(reader, "absent-session");
            expect(absent.cachedM0Bytes).toBeNull();
            expect(absent.memoryBlockCount).toBe(0);
        } finally {
            reader.close();
        }
    });

    test("a mural or a visible-memory count prevents the history-only exception", () => {
        commitFrame("history-has-data", undefined, docs);
        const state = readSessionMeta(db, "history-has-data");
        expect(
            backgroundSessionProjectIdentity(
                db,
                "history-has-data",
                { ...state, memoryBlockCount: 1 },
                false,
                B,
            ),
        ).toBeUndefined();
        expect(
            backgroundSessionProjectIdentity(
                db,
                "history-has-data",
                { ...state, cachedM0MuralDataUrl: "data:image/png;base64,fixture" },
                false,
                B,
            ),
        ).toBeUndefined();
        expect(
            backgroundSessionProjectIdentity(db, "history-has-data", state, true, B),
        ).toBeUndefined();
    });

    test("review: unknown memory ownership must not suppress the history-only compartment phase", async () => {
        const start = spyOn(compartmentRunner, "startCompartmentAgent").mockImplementation(
            () => {},
        );
        cleanups.push(() => start.mockRestore());
        await runCompartmentPhase({
            db,
            sessionId: "review-history-only-phase",
            resolvedSessionId: "review-history-only-phase",
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: true },
            contextUsage: { percentage: 20 },
            boundaryContextLimit: 128000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 20, inputTokens: 1000 },
            boundaryUsageSource: "live",
            client: { session: {} } as never,
            historianChunkTokens: 10000,
            compartmentDirectory: temp.dir,
            messages: [],
            coveredInstructions: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set<string>(),
            projectOwnerUnavailable: true,
            projectIdentity: undefined,
            memoryEnabled: false,
            autoPromote: false,
        });
        expect(start).toHaveBeenCalledTimes(1);
    });

    test("an unproven historian pauses without clearing intent or blocking other sessions", async () => {
        const common = {
            db,
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: true },
            contextUsage: { percentage: 20 },
            boundaryContextLimit: 128000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 20, inputTokens: 1000 },
            boundaryUsageSource: "live" as const,
            client: { session: {} } as never,
            historianChunkTokens: 10000,
            compartmentDirectory: temp.dir,
            messages: [],
            coveredInstructions: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set<string>(),
            projectIdentity: A,
        };
        updateSessionMeta(db, "paused-historian", { compartmentInProgress: true });
        const start = spyOn(compartmentRunner, "startCompartmentAgent").mockImplementation(
            () => {},
        );
        cleanups.push(() => start.mockRestore());
        const paused = await runCompartmentPhase({
            ...common,
            sessionId: "paused-historian",
            resolvedSessionId: "paused-historian",
            projectOwnerUnavailable: true,
        });
        expect(start).not.toHaveBeenCalled();
        expect(paused.compartmentInProgress).toBe(true);
        expect(readSessionMeta(db, "paused-historian").compartmentInProgress).toBe(true);
        await runCompartmentPhase({
            ...common,
            sessionId: "healthy-historian",
            resolvedSessionId: "healthy-historian",
            projectOwnerUnavailable: false,
        });
        expect(start).toHaveBeenCalledTimes(1);
        expect(start.mock.calls[0]?.[0].sessionId).toBe("healthy-historian");
    });
});

describe("before the first prefix", () => {
    test("an observed decision move wins over an old row and stable reads stay read-only", async () => {
        const sessionId = "owner-before-prefix";
        const tools = toolsFor(sessionId);
        const beta = insertMemory(db, {
            projectPath: B,
            category: "USER_DIRECTIVES",
            content: "pending decision beta",
        });
        recordSessionProjectIdentity(db, sessionId, A);
        await awaitSessionIdentityDecision(sessionId, tools.a, {
            db,
            connectionFile: tools.connectionFile,
        });
        expect(readSessionIdentityDecision(sessionId, tools.b, { db })?.identity).toBe(B);
        expect(
            await tools.memory.execute({ action: "get", ids: [beta.id] }, tools.context),
        ).toContain(beta.content);
        expect(getRecordedSessionProjectIdentity(db, sessionId)).toBe(B);
        let immediateCalls = 0;
        const transaction = db.transaction.bind(db);
        const spy = spyOn(db, "transaction").mockImplementation(((
            ...args: Parameters<typeof db.transaction>
        ) => {
            const tx = transaction(...args);
            const wrapped = ((...values: unknown[]) => tx(...values)) as typeof tx;
            wrapped.immediate = ((...values: unknown[]) => {
                immediateCalls++;
                return tx.immediate(...values);
            }) as typeof tx.immediate;
            wrapped.deferred = tx.deferred.bind(tx);
            wrapped.exclusive = tx.exclusive.bind(tx);
            return wrapped;
        }) as typeof db.transaction);
        cleanups.push(() => spy.mockRestore());
        for (let i = 0; i < 20; i++)
            expect(
                await tools.memory.execute({ action: "get", ids: [beta.id] }, tools.context),
            ).toContain(beta.content);
        expect(immediateCalls).toBe(0);
        expect(readSessionMeta(db, sessionId).cachedM0Bytes).toBeNull();
    });

    test("a prefix created after the initial snapshot takes precedence over the pending decision", async () => {
        const sessionId = "owner-after-snapshot";
        const tools = toolsFor(sessionId);
        const early = readSessionMeta(db, sessionId);
        expect(early.cachedM0Bytes).toBeNull();
        commitFrame(sessionId, A, "<session-history>created while pending</session-history>");
        recordSessionProjectIdentity(db, sessionId, B);
        expect(
            await resolveSessionProjectIdentity(sessionId, tools.b, {
                db,
                sessionMeta: early,
                connectionFile: tools.connectionFile,
            }),
        ).toBe(A);
        expect(getRecordedSessionProjectIdentity(db, sessionId)).toBe(A);
    });
});
