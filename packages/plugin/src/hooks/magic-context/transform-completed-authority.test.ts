import { expect, test } from "bun:test";
import {
    getAuthorityManagedMarker,
    installAuthorityManagedMarker,
} from "../../features/magic-context/context-authority";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { addNote } from "../../features/magic-context/storage-notes";
import { getProjectState } from "../../features/magic-context/storage-project-state";
import { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";
import { recoverTsAuthorityProject } from "./transform";

for (const mode of ["TS", "unowned", "concurrent"] as const) {
    test(`TypeScript recovery heals a completed ${mode} handoff exactly once`, async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const projectPath = `git:recover-completed-${mode}`;
        installAuthorityManagedMarker(db, projectPath);
        const roots: string[] = [];
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => {
                roots.push(String(args.projectRoot));
                return {
                    authority: mode === "unowned" ? null : { ...args, state: "TS", generation: 3 },
                };
            },
            authorityDrain: async () => {
                throw new Error("completed handoff must not drain again");
            },
            markerStatus: async () => ({ ok: true }),
            mirrorPull: async () => {
                throw new Error("completed handoff must not mirror again");
            },
        };
        const recover = () =>
            recoverTsAuthorityProject({ db, projectPath, projectRoot: "/fixture-root", module });
        try {
            if (mode === "concurrent") {
                expect(await Promise.all([recover(), recover()])).toEqual([
                    "completed",
                    "completed",
                ]);
            } else {
                expect(await recover()).toBe("completed");
            }
            expect(getAuthorityManagedMarker(db, projectPath)).toBeNull();
            expect(getProjectState(db, projectPath)?.projectMemoryEpoch).toBe(1);
            expect(await recover()).toBe("completed");
            expect(getProjectState(db, projectPath)?.projectMemoryEpoch).toBe(1);
            expect(roots.length).toBeGreaterThan(0);
            expect(roots.every((root) => root === "/fixture-root")).toBe(true);
            expect(() =>
                insertMemory(db, {
                    projectPath,
                    category: "CONSTRAINTS",
                    content: "recovered memory",
                    sourceSessionId: "fixture",
                }),
            ).not.toThrow();
            expect(() =>
                addNote(db, "smart", {
                    projectPath,
                    content: "recovered note",
                    surfaceCondition: "later",
                }),
            ).not.toThrow();
        } finally {
            db.close();
        }
    });
}

test("TypeScript recovery keeps a mismatched completed handoff retryable and fenced", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const projectPath = "git:completed-wrong-store";
    installAuthorityManagedMarker(db, projectPath);
    const module: RustModeModuleClient = {
        call: async () => ({ ok: true }),
        authorityStatus: async (args) => ({
            authority: {
                ...args,
                context_store_uuid: "different-store",
                state: "TS",
                generation: 3,
            },
        }),
        authorityDrain: async () => {
            throw new Error("must not drain");
        },
        markerStatus: async () => ({ ok: true }),
        mirrorPull: async () => {
            throw new Error("must not mirror");
        },
    };
    try {
        expect(
            await recoverTsAuthorityProject({
                db,
                projectPath,
                projectRoot: "/fixture-root",
                module,
            }),
        ).toBe("retryable");
        expect(getAuthorityManagedMarker(db, projectPath)).not.toBeNull();
        expect(getProjectState(db, projectPath)?.projectMemoryEpoch ?? 0).toBe(0);
    } finally {
        db.close();
    }
});

for (const mode of ["failed-status", "preparing-notes"] as const) {
    test(`TypeScript recovery preserves ordinary write fences for ${mode}`, async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const projectPath = `git:incomplete-${mode}`;
        installAuthorityManagedMarker(db, projectPath);
        const before = getAuthorityManagedMarker(db, projectPath);
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => {
                if (mode === "failed-status" && args.domain === "notes") {
                    throw new Error("status unavailable");
                }
                return {
                    authority: {
                        ...args,
                        state: args.domain === "notes" ? "PREPARING" : "TS",
                        generation: 3,
                    },
                };
            },
            authorityDrain: async () => {
                throw new Error("must not drain a preparing domain");
            },
            markerStatus: async () => ({ ok: true }),
            mirrorPull: async () => {
                throw new Error("must not pull a preparing domain");
            },
        };
        try {
            const recovery = recoverTsAuthorityProject({
                db,
                projectPath,
                projectRoot: "/fixture-root",
                module,
            });
            if (mode === "failed-status")
                await expect(recovery).rejects.toThrow("status unavailable");
            else expect(await recovery).toBe("retryable");
            expect(getAuthorityManagedMarker(db, projectPath)).toEqual(before);
            expect(getProjectState(db, projectPath)?.projectMemoryEpoch ?? 0).toBe(0);
            expect(() =>
                insertMemory(db, {
                    projectPath,
                    category: "CONSTRAINTS",
                    content: "must remain fenced",
                    sourceSessionId: "fixture",
                }),
            ).toThrow();
            expect(() =>
                addNote(db, "smart", {
                    projectPath,
                    content: "must remain fenced",
                    surfaceCondition: "later",
                }),
            ).toThrow();
        } finally {
            db.close();
        }
    });
}

test("drain completion racing with completed-handoff recovery invalidates once", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const projectPath = "git:drain-release-interleaving";
    installAuthorityManagedMarker(db, projectPath);
    let notesState: "MODULE" | "DRAINING" | "TS" = "MODULE";
    let announceFinished!: () => void;
    let resumeFinish!: () => void;
    const finished = new Promise<void>((resolve) => {
        announceFinished = resolve;
    });
    const resume = new Promise<void>((resolve) => {
        resumeFinish = resolve;
    });
    const module: RustModeModuleClient = {
        call: async () => ({ ok: true }),
        authorityStatus: async (args) => ({
            authority: {
                ...args,
                state: args.domain === "notes" ? notesState : "TS",
                generation: 3,
            },
        }),
        authorityDrain: async (args) => {
            notesState = args.action === "finish" ? "TS" : "DRAINING";
            if (args.action === "finish") {
                announceFinished();
                await resume;
            }
            return {
                authority: {
                    ...args,
                    state: notesState,
                    generation: 3,
                    captured_upper_bound: 0,
                    coordinator_token: "fixture-token",
                },
            };
        },
        markerStatus: async () => ({ ok: true }),
        mirrorPull: async () => {
            throw new Error("empty notes drain must not pull");
        },
    };
    const recover = () =>
        recoverTsAuthorityProject({ db, projectPath, projectRoot: "/fixture-root", module });
    const draining = recover();
    try {
        await finished;
        expect(await recover()).toBe("completed");
        expect(getProjectState(db, projectPath)?.projectMemoryEpoch).toBe(1);
        resumeFinish();
        expect(await draining).toBe("completed");
        expect(getAuthorityManagedMarker(db, projectPath)).toBeNull();
        expect(getProjectState(db, projectPath)?.projectMemoryEpoch).toBe(1);
    } finally {
        resumeFinish();
        await draining.catch(() => undefined);
        db.close();
    }
});
