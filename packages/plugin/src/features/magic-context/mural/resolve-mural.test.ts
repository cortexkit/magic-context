/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory, setMemoryClassification } from "../memory";
import type { Memory } from "../memory/types";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { ensureMuralRendered, muralCoverageGate } from "./render-trigger";
import { getMuralCoverage, readMuralPool, resolveMural } from "./resolve-mural";
import { getMural } from "./storage-mural";
import { computeCueContentHash, setMuralCue } from "./storage-mural-cues";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** Insert a memory, classify its importance, and give it a hash-current cue. */
function seedCuedMemory(
    db: Database,
    project: string,
    category: Memory["category"],
    content: string,
    importance: number,
): Memory {
    const memory = insertMemory(db, {
        projectPath: project,
        category,
        content,
        sourceSessionId: "s",
    });
    setMemoryClassification(db, memory.id, { importance });
    setMuralCue(
        db,
        memory.projectPath,
        memory.id,
        `cue-${memory.id}`,
        computeCueContentHash(content),
    );
    return memory;
}

describe("resolveMural", () => {
    test("a shared refresh pool preserves coverage and ordered entries including blank and stale cues", () => {
        const db = freshDb();
        try {
            const project = "git:shared-pool";
            for (let i = 0; i < 25; i++) {
                const memory = seedCuedMemory(
                    db,
                    project,
                    i % 2 ? "CONSTRAINTS" : "ARCHITECTURE",
                    `fact ${i}`,
                    i,
                );
                if (i === 1)
                    setMuralCue(db, project, memory.id, " ", computeCueContentHash(memory.content));
                if (i === 2)
                    setMuralCue(
                        db,
                        project,
                        memory.id,
                        "stale",
                        computeCueContentHash("old content"),
                    );
            }
            const pool = readMuralPool(db, project);
            expect(getMuralCoverage(db, project, pool)).toEqual(getMuralCoverage(db, project));
            expect(resolveMural(db, project, 1, pool)).toEqual(resolveMural(db, project, 1));
            const before = getMuralCoverage(db, project, pool).cuedMemoryCount;
            const edited = pool.memories.find((memory) => memory.content === "fact 3");
            if (!edited) throw new Error("Missing hash-current fixture memory");
            edited.content = "edited snapshot content";
            expect(getMuralCoverage(db, project, pool).cuedMemoryCount).toBe(before - 1);
        } finally {
            db.close();
        }
    });
    test("selects only the overflow complement of the budget trim", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            // A tiny budget so almost everything overflows. Seed enough memories
            // that the trim keeps a few and drops the rest.
            const ids: number[] = [];
            for (let i = 0; i < 30; i++) {
                const m = seedCuedMemory(
                    db,
                    project,
                    "ARCHITECTURE",
                    `memory number ${i} with enough text to cost tokens in the budget accounting`,
                    50,
                );
                ids.push(m.id);
            }
            const entries = resolveMural(db, project, 200);
            // Some memories fit the 200-token budget (excluded from the mural),
            // the rest overflow (included). So the mural is a strict subset.
            expect(entries.length).toBeGreaterThan(0);
            expect(entries.length).toBeLessThan(ids.length);
        } finally {
            closeQuietly(db);
        }
    });

    test("excludes memories with no cue or a stale cue (absent until compressed)", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            // One cued, one un-cued, both overflow under a tiny budget.
            const cued = seedCuedMemory(db, project, "ARCHITECTURE", "cued fact here", 50);
            const unCued = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: "uncompressed fact",
                sourceSessionId: "s",
            });
            setMemoryClassification(db, unCued.id, { importance: 50 });
            // A stale cue: hash points at different content.
            const stale = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: "current content",
                sourceSessionId: "s",
            });
            setMemoryClassification(db, stale.id, { importance: 50 });
            setMuralCue(
                db,
                stale.projectPath,
                stale.id,
                "stale cue",
                computeCueContentHash("OLD content"),
            );

            const entries = resolveMural(db, project, 1);
            const idsOut = entries.map((entry) => entry.id);
            expect(idsOut).toContain(cued.id);
            expect(idsOut).not.toContain(unCued.id);
            expect(idsOut).not.toContain(stale.id);
        } finally {
            closeQuietly(db);
        }
    });

    test("orders by category band, then importance DESC, then id ASC (append-stable)", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            // NAMING sorts after ARCHITECTURE; within a band, higher importance
            // first, then lower id first.
            const archLow = seedCuedMemory(db, project, "ARCHITECTURE", "arch low imp", 40);
            const archHigh = seedCuedMemory(db, project, "ARCHITECTURE", "arch high imp", 90);
            const naming = seedCuedMemory(db, project, "NAMING", "naming fact", 90);

            const entries = resolveMural(db, project, 1);
            const order = entries.map((entry) => entry.id);
            // ARCHITECTURE band first (high before low), then NAMING band.
            expect(order.indexOf(archHigh.id)).toBeLessThan(order.indexOf(archLow.id));
            expect(order.indexOf(archLow.id)).toBeLessThan(order.indexOf(naming.id));

            // Append-stability: inserting a NEW same-band, same-importance memory
            // (a higher id) must land AFTER the existing one, never reshuffle it.
            const archHigh2 = seedCuedMemory(db, project, "ARCHITECTURE", "arch high 2", 90);
            const after = resolveMural(db, project, 1).map((entry) => entry.id);
            expect(after.indexOf(archHigh.id)).toBeLessThan(after.indexOf(archHigh2.id));
            // The pre-existing relative order (archHigh before archLow) is intact.
            expect(after.indexOf(archHigh.id)).toBeLessThan(after.indexOf(archLow.id));
        } finally {
            closeQuietly(db);
        }
    });
});

describe("mural coverage gate", () => {
    test("requires 15 cues unless at least half of the active pool is cued", () => {
        expect(muralCoverageGate(14, 100)).toBe(false);
        expect(muralCoverageGate(15, 100)).toBe(true);
        expect(muralCoverageGate(7, 10)).toBe(true);
        expect(muralCoverageGate(6, 13)).toBe(false);
    });

    test("skips rendering and explains a near-empty cue pool", () => {
        const db = freshDb();
        try {
            const project = "git:coverage-gate";
            for (let i = 0; i < 40; i++) {
                if (i < 10) {
                    seedCuedMemory(db, project, "ARCHITECTURE", `cued fact ${i}`, 50);
                } else {
                    insertMemory(db, {
                        projectPath: project,
                        category: "ARCHITECTURE",
                        content: `uncued fact ${i}`,
                        sourceSessionId: "s",
                    });
                }
            }
            const result = ensureMuralRendered(db, project, 1);
            expect(result.hasMural).toBe(false);
            expect(result.rerendered).toBe(false);
            expect(result.skipReason).toContain("10/40");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ensureMuralRendered (on-demand render + change detection)", () => {
    test("first render stores a row; unchanged pool does not re-render", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            for (let i = 0; i < 25; i++) {
                seedCuedMemory(
                    db,
                    project,
                    "ARCHITECTURE",
                    `fact ${i} with plenty of words to overflow a tiny budget for sure`,
                    50,
                );
            }
            const first = ensureMuralRendered(db, project, 100);
            expect(first.hasMural).toBe(true);
            expect(first.rerendered).toBe(true);
            expect(first.dataUrl).toBeDefined();
            const stored = getMural(db, project);
            expect(stored?.width).toBe(first.width);
            expect(stored?.height).toBe(first.height);

            // Same pool → same text hash → no re-render, same data URL bytes.
            const second = ensureMuralRendered(db, project, 100);
            expect(second.hasMural).toBe(true);
            expect(second.rerendered).toBe(false);
            expect(second.contentHash).toBe(first.contentHash);
            expect(second.dataUrl).toBe(first.dataUrl);
        } finally {
            closeQuietly(db);
        }
    });

    test("an empty cue pool yields no mural (m0 omits the block)", () => {
        const db = freshDb();
        try {
            // Memories exist but none are cued → resolveMural returns [].
            const project = "git:p";
            insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: "uncompressed",
                sourceSessionId: "s",
            });
            const result = ensureMuralRendered(db, project, 1);
            expect(result.hasMural).toBe(false);
            expect(result.rerendered).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("a changed cue pool re-renders with a new content hash", () => {
        const db = freshDb();
        try {
            const project = "git:p";
            for (let i = 0; i < 25; i++) {
                seedCuedMemory(db, project, "ARCHITECTURE", `fact ${i} padding words here now`, 50);
            }
            const first = ensureMuralRendered(db, project, 100);
            // Add a new cued overflow memory → resolved text changes → re-render.
            seedCuedMemory(db, project, "NAMING", "a brand new naming cue entry appears", 90);
            const second = ensureMuralRendered(db, project, 100);
            expect(second.rerendered).toBe(true);
            expect(second.contentHash).not.toBe(first.contentHash);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("cues the mural font cannot draw", () => {
    function seedMemoryWithCue(
        db: Database,
        project: string,
        content: string,
        importance: number,
        cue: string,
    ): Memory {
        const memory = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content,
            sourceSessionId: "s",
        });
        setMemoryClassification(db, memory.id, { importance });
        setMuralCue(db, project, memory.id, cue, computeCueContentHash(content));
        return memory;
    }

    test("the coverage gate counts only drawable cues", () => {
        const db = freshDb();
        try {
            const project = "git:undrawable-coverage";
            const chineseIds = new Set<number>();
            for (let i = 0; i < 40; i++) {
                const memory = seedMemoryWithCue(
                    db,
                    project,
                    `内存事实 ${i}`,
                    50,
                    `缓存 ${i} → 破坏`,
                );
                chineseIds.add(memory.id);
            }
            for (let i = 0; i < 2; i++) {
                seedMemoryWithCue(db, project, `drawable fact ${i}`, 50, `drawable cue ${i}`);
            }

            // 42 current cues, but only two the font can draw: below both the
            // 15-cue floor and half of the pool, so no image.
            expect(getMuralCoverage(db, project)).toEqual({
                activeMemoryCount: 42,
                cuedMemoryCount: 2,
                undrawableCueCount: 40,
            });
            const skipped = ensureMuralRendered(db, project, 1);
            expect(skipped.hasMural).toBe(false);
            expect(skipped.dataUrl).toBeUndefined();
            expect(skipped.skipReason).toContain("2/42");
            expect(skipped.skipReason).toContain("40 more");
            expect(getMural(db, project)).toBeNull();

            // Fifteen drawable cues pass the gate; the image holds only those.
            for (let i = 2; i < 15; i++) {
                seedMemoryWithCue(db, project, `drawable fact ${i}`, 50, `drawable cue ${i}`);
            }
            const rendered = ensureMuralRendered(db, project, 1);
            expect(rendered.hasMural).toBe(true);
            expect(rendered.dataUrl).toBeDefined();
            const stored = getMural(db, project);
            expect(stored?.memoryIds).toHaveLength(15);
            expect(stored?.memoryIds.some((id) => chineseIds.has(id))).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("no image when every overflow cue is undrawable, even past the coverage gate", () => {
        const db = freshDb();
        try {
            const project = "git:undrawable-overflow";
            // Fifteen short drawable memories fit the memory block; long Chinese
            // memories overflow it, so the mural would show only Chinese cues.
            for (let i = 0; i < 15; i++) {
                seedMemoryWithCue(db, project, `short fact ${i}`, 90, `short cue ${i}`);
            }
            const chineseIds: number[] = [];
            for (let i = 0; i < 5; i++) {
                const memory = seedMemoryWithCue(
                    db,
                    project,
                    `长记忆内容${i}`.repeat(2_000),
                    10,
                    `缓存写入 ${i} → 破坏`,
                );
                chineseIds.push(memory.id);
            }
            const budget = 1_000;
            expect(
                resolveMural(db, project, budget)
                    .map((entry) => entry.id)
                    .sort((a, b) => a - b),
            ).toEqual(chineseIds);

            const result = ensureMuralRendered(db, project, budget);
            expect(result.hasMural).toBe(false);
            expect(result.dataUrl).toBeUndefined();
            expect(result.skipReason).toContain("none of the 5 overflow cues can be drawn");
            expect(getMural(db, project)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
