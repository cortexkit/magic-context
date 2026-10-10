import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createPiM0M1PassSnapshot,
    injectM0M1Pi,
    mustMaterializePi,
    type PiM0M1State,
    __test as piTest,
} from "../../../../pi-plugin/src/inject-compartments-pi";
import { insertMemory, setMemoryClassification } from "../../features/magic-context/memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { getMural } from "../../features/magic-context/mural/storage-mural";
import {
    computeCueContentHash,
    setMuralCue,
} from "../../features/magic-context/mural/storage-mural-cues";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import * as modelMetadata from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { injectM0M1, type M0M1RenderOptions, mustMaterialize } from "./inject-compartments";

const SESSION = "fresh-mural-contention";
const PROJECT = "git:fresh-mural-contention";
const resources: Array<{ db: Database; directory: string }> = [];

function database(): { db: Database; path: string } {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-test-fresh-mural-contention-"));
    const path = join(directory, "context.db");
    const db = new Database(path);
    resources.push({ db, directory });
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1");
    getOrCreateSessionMeta(db, SESSION);
    for (let i = 0; i < 8; i++) {
        db.prepare(`INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, p1, p2, p3, p4, importance, legacy, episode_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 0, 'feature', 1234)`).run(
            SESSION,
            i,
            i * 2 + 1,
            i * 2 + 2,
            `start-${i}`,
            `end-${i}`,
            `row-${i}`,
            `row-${i}-P1`,
            `row-${i}-P2`,
            `row-${i}-P3`,
            `row-${i}-P4`,
            i === 0 ? 1 : 50,
        );
    }
    return { db, path };
}

function harness(runtime: "TS" | "Pi", db: Database, muralEnabled = true) {
    const signals = {
        systemHash: "",
        modelKey: "anthropic/review-vision",
        cacheExpired: false,
        lastResponseTime: 0,
    };
    const options: M0M1RenderOptions = {
        db,
        sessionId: SESSION,
        state: getOrCreateSessionMeta(db, SESSION),
        projectPath: PROJECT,
        projectDirectory: "",
        injectDocs: false,
        historyBudgetTokens: 1250,
        memoryInjectionBudgetTokens: 1,
        muralEnabled,
        hardSignals: signals,
    };
    const pi: PiM0M1State = {
        sessionId: SESSION,
        projectIdentity: PROJECT,
        projectDirectory: "",
        injectDocs: false,
        historyBudgetTokens: 1250,
        injectionBudgetTokens: 1,
        muralEnabled,
        hardSignals: signals,
    };
    return {
        options,
        pi,
        inject(soft = false) {
            options.state = getOrCreateSessionMeta(db, SESSION);
            if (runtime === "TS") {
                const r = injectM0M1({ ...options, isCacheBustingPass: soft });
                return {
                    m0: r.m0Bytes!.toString(),
                    m1: r.m1Text!,
                    image: options.state.cachedM0MuralDataUrl,
                    committed: r.m0RematerializedThisPass,
                    contention: r.materializationContentionRetryExhausted,
                };
            }
            const messages: Parameters<typeof injectM0M1Pi>[2] = [];
            const r = injectM0M1Pi(pi, db, messages, undefined, soft);
            const text = (i: number) => {
                const m = messages[i];
                if (m.role !== "user") throw new Error("Expected injected user message");
                return typeof m.content === "string"
                    ? m.content
                    : m.content
                          .filter((p) => p.type === "text")
                          .map((p) => p.text)
                          .join("");
            };
            const head = messages[0];
            const image =
                head.role === "user" && Array.isArray(head.content)
                    ? head.content.find((p) => p.type === "image")
                    : undefined;
            return {
                m0: text(0),
                m1: text(1),
                image: image ? `data:${image.mimeType};base64,${image.data}` : null,
                committed: r.m0Materialized,
                contention: r.contentionExhausted,
            };
        },
        allowFresh() {
            options.allowFreshContentionFallback = true;
            pi.allowFreshContentionFallback = true;
        },
        forceSoftFailure(enabled: boolean) {
            // Make the history-head refresh fail as if its write lock were busy, but
            // with no other connection actually holding a lock. A mural upsert from
            // the fallback would then succeed instead of failing, so the zero-write
            // assertion (total_changes) is what catches it.
            const fail = enabled
                ? () => {
                      throw new Error("forced soft acquisition failure");
                  }
                : undefined;
            options.beforeCacheCommitForTest = fail;
            pi.beforeCacheCommitForTest = fail;
        },
    };
}

function seedCues(db: Database) {
    for (let i = 0; i < 25; i++) {
        const content = `Architecture fact ${i} with enough words to overflow the baseline budget`;
        const memory = insertMemory(db, {
            projectPath: PROJECT,
            category: "ARCHITECTURE",
            content,
            sourceSessionId: SESSION,
        });
        setMemoryClassification(db, memory.id, { importance: 50 });
        setMuralCue(
            db,
            PROJECT,
            memory.id,
            `architecture cue ${i}`,
            computeCueContentHash(content),
        );
    }
}

function persisted(db: Database) {
    return db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(SESSION);
}

function totalChanges(db: Database): number {
    return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

afterEach(() => {
    for (const { db, directory } of resources.splice(0)) {
        db.close();
        cleanupTestTempDir(directory);
    }
});

describe("fresh mural contention issue", () => {
    for (const runtime of ["TS", "Pi"] as const) {
        for (const muralEnabled of [false, true]) {
            it(`${runtime} fresh contention fallback writes nothing with mural=${muralEnabled}`, () => {
                const { db, path } = database();
                const h = harness(runtime, db, muralEnabled);
                const vision = spyOn(modelMetadata, "modelSupportsVision").mockReturnValue(true);
                let writer: Database | undefined;
                try {
                    const first = h.inject();
                    seedCues(db);
                    h.allowFresh();
                    h.options.state = getOrCreateSessionMeta(db, SESSION);
                    expect(
                        runtime === "TS"
                            ? mustMaterialize(h.options).value
                            : mustMaterializePi(h.pi, db).value,
                    ).toBe(false);
                    const before = persisted(db);
                    const changes = totalChanges(db);
                    expect(db.prepare("SELECT * FROM mural_manifest").all()).toEqual([]);
                    writer = new Database(path);
                    writer.exec("PRAGMA busy_timeout=1; BEGIN IMMEDIATE");
                    const fallback = h.inject(true);
                    expect(fallback.committed).toBe(false);
                    expect(fallback.contention).toBe(true);
                    expect(fallback.m0).toContain("row-0-P4");
                    expect(fallback.m0).not.toContain("row-0-P1");
                    if (!muralEnabled) expect(fallback.m0).toBe(first.m0);
                    else {
                        expect(fallback.m0).toContain("<memory-mural>");
                        expect(fallback.image).toStartWith("data:image/png;base64,");
                    }
                    expect(persisted(db)).toEqual(before);
                    expect(db.prepare("SELECT * FROM mural_manifest").all()).toEqual([]);
                    expect(totalChanges(db)).toBe(changes);
                } finally {
                    if (writer) {
                        writer.exec("ROLLBACK");
                        writer.close();
                    }
                    vision.mockRestore();
                }
            });
        }

        for (const manifest of ["missing", "matching", "stale"] as const) {
            it(`${runtime} fresh mural writes zero rows without a competing writer (${manifest} manifest) and matches persisted HARD bytes`, () => {
                const { db } = database();
                const h = harness(runtime, db);
                const vision = spyOn(modelMetadata, "modelSupportsVision").mockReturnValue(true);
                try {
                    h.inject();
                    seedCues(db);
                    if (manifest !== "missing") {
                        h.options.hardSignals!.systemHash = "persist-mural";
                        const hard = h.inject();
                        expect(hard.committed).toBe(true);
                        expect(hard.image).toStartWith("data:image/png;base64,");
                        const soft = h.inject(true);
                        expect(soft.committed).toBe(false);
                        expect(soft.contention).toBe(false);
                        expect(soft.m0).toBe(hard.m0);
                        expect(soft.m1).toBe(hard.m1);
                        expect(soft.image).toBe(hard.image);
                    }
                    if (manifest === "stale") {
                        const memory = db
                            .prepare(
                                "SELECT id, content FROM memories WHERE project_path = ? ORDER BY id LIMIT 1",
                            )
                            .get(PROJECT) as { id: number; content: string };
                        setMuralCue(
                            db,
                            PROJECT,
                            memory.id,
                            "changed architecture cue",
                            computeCueContentHash(memory.content),
                        );
                    }
                    h.allowFresh();
                    h.forceSoftFailure(true);
                    const before = persisted(db);
                    const stored = getMural(db, PROJECT);
                    const changes = totalChanges(db);
                    const fallback = h.inject(true);
                    expect(fallback.contention).toBe(true);
                    expect(fallback.committed).toBe(false);
                    expect(fallback.m0).toContain("<memory-mural>");
                    expect(fallback.image).toStartWith("data:image/png;base64,");
                    expect(totalChanges(db)).toBe(changes);
                    expect(persisted(db)).toEqual(before);
                    expect(getMural(db, PROJECT)).toEqual(stored);
                    if (manifest === "matching") {
                        expect(fallback.image).toBe(
                            `data:image/png;base64,${stored!.image.toString("base64")}`,
                        );
                    }
                    if (manifest === "stale") {
                        expect(fallback.image).not.toBe(
                            `data:image/png;base64,${stored!.image.toString("base64")}`,
                        );
                    }
                    h.forceSoftFailure(false);
                    h.options.hardSignals!.systemHash = "next-hard";
                    const hard = h.inject();
                    expect(hard.committed).toBe(true);
                    expect(hard.m0).toBe(fallback.m0);
                    expect(hard.m1).toBe(fallback.m1);
                    expect(hard.image).toBe(fallback.image);
                    const meta = getOrCreateSessionMeta(db, SESSION);
                    expect(meta.cachedM0Bytes!.toString()).toBe(hard.m0);
                    expect(meta.cachedM1Bytes!.toString()).toBe(hard.m1);
                    expect(meta.cachedM0MuralDataUrl).toBe(hard.image);
                    const soft = h.inject(true);
                    expect(soft.committed).toBe(false);
                    expect(soft.contention).toBe(false);
                    expect(soft.m0).toBe(hard.m0);
                    expect(soft.m1).toBe(hard.m1);
                    expect(soft.image).toBe(hard.image);
                } finally {
                    vision.mockRestore();
                }
            });
        }
    }

    it("Pi fresh snapshot and mural fallback do not create missing session meta", () => {
        const { db } = database();
        seedCues(db);
        db.prepare("DELETE FROM session_meta WHERE session_id = ?").run(SESSION);
        const vision = spyOn(modelMetadata, "modelSupportsVision").mockReturnValue(true);
        try {
            const changes = totalChanges(db);
            const snapshot = createPiM0M1PassSnapshot({
                db,
                sessionId: SESSION,
                compactionOff: false,
            });
            expect(snapshot.sessionMeta.cachedM0Bytes).toBeNull();
            const fresh = piTest.renderFreshM0PiNonPersisted(
                {
                    sessionId: SESSION,
                    projectIdentity: PROJECT,
                    projectDirectory: "",
                    injectDocs: false,
                    muralEnabled: true,
                    injectionBudgetTokens: 1,
                    historyBudgetTokens: 1250,
                    hardSignals: {
                        systemHash: "",
                        modelKey: "anthropic/review-vision",
                        cacheExpired: false,
                        lastResponseTime: 0,
                    },
                },
                db,
            );
            expect(fresh.m0).toContain("<memory-mural>");
            expect(fresh.snapshotMarkers.materializedAt).toBe(0);
            expect(totalChanges(db)).toBe(changes);
            expect(persisted(db)).toBeNull();
            expect(getMural(db, PROJECT)).toBeNull();
        } finally {
            vision.mockRestore();
        }
    });
});
