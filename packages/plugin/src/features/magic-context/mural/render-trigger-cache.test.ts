import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "../../../shared/sqlite";
import { insertMemory, setMemoryClassification } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import * as renderer from "./render-mural";
import { ensureMuralRendered, resolveMuralWire } from "./render-trigger";
import { resolveMural } from "./resolve-mural";
import { computeCueContentHash, setMuralCue } from "./storage-mural-cues";

function seed(db: Database, index: number) {
    const content = `Architecture fact ${index}: source files and nested control flow are preserved.`;
    const memory = insertMemory(db, {
        projectPath: "git:cache",
        category: "ARCHITECTURE",
        content,
        sourceSessionId: "test",
    });
    setMemoryClassification(db, memory.id, { importance: index % 100 });
    setMuralCue(
        db,
        memory.projectPath,
        memory.id,
        `Fact ${index}: preserve the ordered control flow and Unicode é ∀.`,
        computeCueContentHash(content),
    );
    return memory;
}

function database() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    for (let index = 0; index < 40; index++) seed(db, index);
    return db;
}

function expectFull(db: Database, budget: number) {
    const full = renderer.renderMural(resolveMural(db, "git:cache", budget));
    const actual = ensureMuralRendered(db, "git:cache", budget);
    expect(actual.dataUrl).toBe(full.dataUrl);
    expect(actual.contentHash).toBe(createHash("sha256").update(full.sha256Input).digest("hex"));
    expect(actual.width).toBe(full.width);
    expect(actual.height).toBe(full.height);
    return actual;
}

test("unchanged mural skips layout raster and PNG while preserving full wire bytes", () => {
    const db = database();
    const plan = spyOn(renderer, "planMuralRender");
    const render = spyOn(renderer, "renderPlannedMural");
    try {
        const first = expectFull(db, 1);
        plan.mockClear();
        render.mockClear();
        expect(ensureMuralRendered(db, "git:cache", 1)).toEqual({ ...first, rerendered: false });
        expect(plan).not.toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
    } finally {
        plan.mockRestore();
        render.mockRestore();
        db.close();
    }
});

for (const change of ["added memory", "changed cue", "changed budget", "stale cue"] as const) {
    test(`mural cache matches full wire after ${change}`, () => {
        const db = database();
        try {
            const previous = expectFull(db, 1);
            let budget = 1;
            if (change === "added memory") seed(db, 40);
            if (change === "changed budget") budget = 700;
            if (change === "changed cue") {
                const memory = db
                    .prepare("SELECT id,content FROM memories ORDER BY id LIMIT 1")
                    .get() as { id: number; content: string };
                setMuralCue(
                    db,
                    "git:cache",
                    memory.id,
                    "Changed cue with different provider-visible words",
                    computeCueContentHash(memory.content),
                );
            }
            if (change === "stale cue")
                db.prepare(
                    "UPDATE memories SET content=? WHERE id=(SELECT MIN(id) FROM memories)",
                ).run("Changed underlying content");
            const next = expectFull(db, budget);
            expect(next.contentHash).not.toBe(previous.contentHash);
        } finally {
            db.close();
        }
    });
}

test("mural cache cannot bypass the nonvision model gate", () => {
    const db = database();
    try {
        expectFull(db, 1);
        expect(resolveMuralWire(db, "git:cache", "unknown/nonvision", true, 1)).toEqual({
            enabled: true,
            supportsVision: false,
        });
        expect(resolveMuralWire(db, "git:cache", undefined, true, 1).dataUrl).toBeUndefined();
    } finally {
        db.close();
    }
});
