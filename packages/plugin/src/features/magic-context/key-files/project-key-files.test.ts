import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildKeyFilesBlock,
    clearKeyFilesCacheForSession,
    readVersionedKeyFiles,
} from "../../../hooks/magic-context/key-files-block";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { peekLeaseHolderAndExpiry } from "../dreamer/lease";
import { setDreamState } from "../dreamer/storage-dream-state";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getAftAvailability, setAftAvailabilityOverride } from "./aft-availability";
import { commitKeyFiles, validateLlmOutput } from "./identify-key-files";
import {
    deleteOrphanProjectKeyFiles,
    getKeyFilesVersion,
    readCurrentKeyFiles,
    replaceProjectKeyFiles,
    sha256,
} from "./project-key-files";
import { coalesceRanges, collectKeyFileCandidates } from "./read-history";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
    setAftAvailabilityOverride(null);
    process.env.HOME = originalHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function seedLease(db: Database, holder = "holder"): void {
    setDreamState(db, "dreaming_lease_holder", holder);
    setDreamState(db, "dreaming_lease_expiry", String(Date.now() + 60_000));
}

describe("project-scoped key-files storage", () => {
    it("bumps versions atomically with row replacement", () => {
        const db = makeDb();
        try {
            const project = tempDir("kf-project-");
            writeFileSync(join(project, "a.ts"), "export const a = 1;\n");

            expect(getKeyFilesVersion(db, project)).toBe(0);
            const version = replaceProjectKeyFiles(db, project, [
                {
                    path: "a.ts",
                    content: "outline a",
                    localTokenEstimate: 10,
                    generationConfigHash: "cfg",
                    generatedByModel: "test-model",
                },
            ]);

            expect(version).toBe(1);
            expect(getKeyFilesVersion(db, project)).toBe(1);
            const rows = readCurrentKeyFiles(db, project);
            expect(rows).toHaveLength(1);
            expect(rows[0].contentHash).toBe(sha256("export const a = 1;\n"));
        } finally {
            closeQuietly(db);
        }
    });

    it("rolls row writes back if version bump fails", () => {
        const db = makeDb();
        try {
            const project = tempDir("kf-rollback-");
            writeFileSync(join(project, "a.ts"), "old\n");
            seedLease(db);
            const initial = validateLlmOutput(
                JSON.stringify({
                    no_change: false,
                    files: [{ path: "a.ts", content: "old content", approx_token_estimate: 10 }],
                }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            );
            expect(
                commitKeyFiles({
                    db,
                    projectPath: project,
                    validated: initial,
                    configHash: "cfg",
                    modelId: "model",
                    leaseHolderId: "holder",
                }),
            ).toBe(1);

            writeFileSync(join(project, "a.ts"), "new\n");
            const next = validateLlmOutput(
                JSON.stringify({
                    no_change: false,
                    files: [{ path: "a.ts", content: "new content", approx_token_estimate: 10 }],
                }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            );
            expect(() =>
                commitKeyFiles({
                    db,
                    projectPath: project,
                    validated: next,
                    configHash: "cfg",
                    modelId: "model",
                    leaseHolderId: "holder",
                    bumpVersion: () => {
                        throw new Error("boom");
                    },
                }),
            ).toThrow("boom");

            expect(getKeyFilesVersion(db, project)).toBe(1);
            expect(readCurrentKeyFiles(db, project)[0].content).toBe("old content");
        } finally {
            closeQuietly(db);
        }
    });

    it("deletes orphan key-file rows and version rows after grace", () => {
        const db = makeDb();
        try {
            const missingProject = join(tempDir("kf-orphans-root-"), "missing");
            db.prepare(
                `INSERT INTO project_key_files (project_path, path, content, content_hash, local_token_estimate, generated_at, generation_config_hash)
                 VALUES (?, 'a.ts', 'content', 'hash', 1, ?, 'cfg')`,
            ).run(missingProject, Date.now() - 8 * 24 * 60 * 60 * 1000);
            db.prepare(
                "INSERT INTO project_key_files_version (project_path, version) VALUES (?, 4)",
            ).run(missingProject);

            expect(deleteOrphanProjectKeyFiles(db)).toBe(1);
            expect(readCurrentKeyFiles(db, missingProject)).toHaveLength(0);
            expect(getKeyFilesVersion(db, missingProject)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("AFT availability detection", () => {
    it("detects OpenCode JSONC plugin entries and Pi extension entries", () => {
        const home = tempDir("kf-home-");
        process.env.HOME = home;
        mkdirSync(join(home, ".config", "opencode"), { recursive: true });
        mkdirSync(join(home, ".pi", "agent"), { recursive: true });
        writeFileSync(
            join(home, ".config", "opencode", "opencode.jsonc"),
            JSON.stringify({ plugin: ["@cortexkit/aft@latest"] }),
        );
        writeFileSync(
            join(home, ".pi", "agent", "settings.json"),
            JSON.stringify({ extensions: ["@cortexkit/aft-pi"] }),
        );

        const availability = getAftAvailability();
        expect(availability.available).toBe(true);
        expect(availability.opencode).toBe(true);
        expect(availability.pi).toBe(true);
    });
});

describe("key-files lease peek and validation", () => {
    it("peeks the real three-key lease schema without writes", () => {
        const db = makeDb();
        try {
            seedLease(db, "expected");
            expect(peekLeaseHolderAndExpiry(db, "expected")).toBe(true);
            expect(peekLeaseHolderAndExpiry(db, "other")).toBe(false);
            setDreamState(db, "dreaming_lease_expiry", String(Date.now() - 1));
            expect(peekLeaseHolderAndExpiry(db, "expected")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects source_files, path escapes, case dupes, and empty replacement output", () => {
        const project = tempDir("kf-validate-");
        writeFileSync(join(project, "a.ts"), "a");
        expect(() =>
            validateLlmOutput(
                JSON.stringify({
                    no_change: false,
                    files: [
                        {
                            path: "a.ts",
                            source_files: ["a.ts"],
                            content: "x",
                            approx_token_estimate: 1,
                        },
                    ],
                }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            ),
        ).toThrow("source_files");
        expect(() =>
            validateLlmOutput(
                JSON.stringify({ no_change: false, files: [] }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            ),
        ).toThrow("empty files");
        expect(() =>
            validateLlmOutput(
                JSON.stringify({
                    no_change: false,
                    files: [{ path: "../x", content: "x", approx_token_estimate: 1 }],
                }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            ),
        ).toThrow("escape");
        expect(() =>
            validateLlmOutput(
                JSON.stringify({
                    no_change: false,
                    files: [
                        { path: "a.ts", content: "x", approx_token_estimate: 1 },
                        { path: "A.ts", content: "x", approx_token_estimate: 1 },
                    ],
                }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            ),
        ).toThrow("case-dup");
    });
});

describe("key-files read history", () => {
    it("coalesces adjacent ranges and keeps the three most recent merged ranges", () => {
        const ranges = coalesceRanges([
            { start: 1, end: 5, count: 1, lastReadAt: 10 },
            { start: 15, end: 20, count: 1, lastReadAt: 20 },
            { start: 100, end: 110, count: 1, lastReadAt: 30 },
            { start: 200, end: 210, count: 1, lastReadAt: 40 },
            { start: 300, end: 310, count: 1, lastReadAt: 50 },
        ]);
        expect(ranges).toEqual([
            { start: 300, end: 310, count: 1, lastReadAt: 50 },
            { start: 200, end: 210, count: 1, lastReadAt: 40 },
            { start: 100, end: 110, count: 1, lastReadAt: 30 },
        ]);
    });

    it("aggregates primary-session read history and filters subagents", () => {
        const magicDb = makeDb();
        const openCodeDb = new Database(":memory:");
        try {
            const project = tempDir("kf-history-");
            writeFileSync(join(project, "a.ts"), "a");
            magicDb
                .prepare(
                    "INSERT INTO session_meta (session_id, is_subagent) VALUES ('primary', 0), ('sub', 1)",
                )
                .run();
            openCodeDb.exec("CREATE TABLE part (session_id TEXT, data TEXT, time_created INTEGER)");
            const readPart = (sessionId: string, time: number) => ({
                type: "tool",
                tool: "read",
                state: JSON.stringify({
                    input: { filePath: join(project, "a.ts"), startLine: 1, endLine: 5 },
                    output: "hello",
                }),
                sessionID: sessionId,
                time,
            });
            for (const sessionId of ["primary", "primary", "sub", "sub"]) {
                openCodeDb
                    .prepare("INSERT INTO part (session_id, data, time_created) VALUES (?, ?, ?)")
                    .run(sessionId, JSON.stringify(readPart(sessionId, Date.now())), Date.now());
            }

            const candidates = collectKeyFileCandidates({
                openCodeDb,
                magicDb,
                projectPath: project,
                minReads: 2,
            });
            expect(candidates).toHaveLength(1);
            expect(candidates[0].path).toBe("a.ts");
            expect(candidates[0].totalReads).toBe(2);
            expect(candidates[0].rangedReads).toBe(2);
        } finally {
            closeQuietly(magicDb);
            closeQuietly(openCodeDb);
        }
    });
});

describe("versioned key-files injection", () => {
    it("renders byte-identically across 10 passes and invalidates on commit", () => {
        setAftAvailabilityOverride(true);
        const db = makeDb();
        try {
            const project = tempDir("kf-inject-");
            writeFileSync(join(project, "a.ts"), "a");
            replaceProjectKeyFiles(db, project, [
                {
                    path: "a.ts",
                    content: "<outline a>",
                    localTokenEstimate: 10,
                    generationConfigHash: "cfg",
                },
            ]);
            const sessionMeta = {
                sessionId: "s",
                isSubagent: false,
            } as import("../types").SessionMeta;
            const first = readVersionedKeyFiles({
                db,
                sessionId: "s",
                sessionMeta,
                directory: project,
                isCacheBusting: false,
                config: { enabled: true, tokenBudget: 2000 },
            });
            for (let i = 0; i < 10; i++) {
                expect(
                    readVersionedKeyFiles({
                        db,
                        sessionId: "s",
                        sessionMeta,
                        directory: project,
                        isCacheBusting: false,
                        config: { enabled: true, tokenBudget: 2000 },
                    }),
                ).toBe(first);
            }
            seedLease(db);
            const validated = validateLlmOutput(
                JSON.stringify({
                    no_change: false,
                    files: [{ path: "a.ts", content: "new content", approx_token_estimate: 10 }],
                }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            );
            commitKeyFiles({
                db,
                projectPath: project,
                validated,
                configHash: "cfg",
                modelId: "model",
                leaseHolderId: "holder",
            });
            expect(
                readVersionedKeyFiles({
                    db,
                    sessionId: "s",
                    sessionMeta,
                    directory: project,
                    isCacheBusting: false,
                    config: { enabled: true, tokenBudget: 2000 },
                }),
            ).toContain("new content");
        } finally {
            clearKeyFilesCacheForSession("s");
            closeQuietly(db);
        }
    });

    it("marks drift stale without bumping version or changing rendered bytes", () => {
        setAftAvailabilityOverride(true);
        const db = makeDb();
        try {
            const project = tempDir("kf-drift-");
            writeFileSync(join(project, "a.ts"), "a");
            replaceProjectKeyFiles(db, project, [
                {
                    path: "a.ts",
                    content: "stable content",
                    localTokenEstimate: 10,
                    generationConfigHash: "cfg",
                },
            ]);
            const beforeVersion = getKeyFilesVersion(db, project);
            writeFileSync(join(project, "a.ts"), "changed");
            const first = buildKeyFilesBlock(db, project, { enabled: true, tokenBudget: 2000 });
            const second = buildKeyFilesBlock(db, project, { enabled: true, tokenBudget: 2000 });
            expect(second).toBe(first);
            expect(getKeyFilesVersion(db, project)).toBe(beforeVersion);
            expect(readCurrentKeyFiles(db, project)[0].staleReason).toBe("content_drift");
        } finally {
            closeQuietly(db);
        }
    });

    it("skips subagents before reading the project version", () => {
        setAftAvailabilityOverride(true);
        const db = makeDb();
        try {
            const value = readVersionedKeyFiles({
                db,
                sessionId: "sub",
                sessionMeta: {
                    sessionId: "sub",
                    isSubagent: true,
                } as import("../types").SessionMeta,
                directory: tempDir("kf-sub-"),
                isCacheBusting: false,
                config: { enabled: true, tokenBudget: 2000 },
            });
            expect(value).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
