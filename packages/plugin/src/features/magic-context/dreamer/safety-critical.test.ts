import { expect, test } from "bun:test";
import selectionCase from "../../../../../../crates/mc-module/testdata/safety_critical_classify_selection.json";
import scoreCases from "../../../../../../crates/mc-store/testdata/safety-score-cases.json";
import { Database } from "../../../shared/sqlite";
import {
    getMemoryById,
    insertMemory,
    setMemoryClassification,
    updateMemoryContent,
} from "../memory";
import { recordItemScores } from "../memory/turn-two-scoring";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { parseClassifyManifest, validateClassifyManifest } from "./classify-prompt";
import { classifySafetyFixture } from "./safety-critical-classify.fixture";

function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const project = "git:safety-classify";
    const rows = Array.from({ length: 10 }, (_, i) =>
        insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: i < 3 ? `Never push without approval: rule ${i}.` : `Ordinary fact ${i}.`,
        }),
    );
    const enqueue = (id: number) =>
        Number(
            db
                .prepare(
                    "INSERT INTO memory_classification_items(project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal,excerpt) VALUES(?,?,1,'ses',?,1,'excerpt')",
                )
                .run(project, id, `part-${id}-${Math.random()}`).lastInsertRowid,
        );
    return { db, project, rows, enqueue };
}

test("classify accepts optional boolean safety assessments without inventing false", () => {
    expect(parseClassifyManifest('<classify><memory id="1" importance="40"/></classify>')).toEqual([
        { id: 1, importance: 40 },
    ]);
    expect(
        validateClassifyManifest(
            '<classify><memory id="1" safety_critical="false"/></classify>',
            new Set([1]),
        ),
    ).toEqual([{ id: 1, safety_critical: false }]);
    expect(
        parseClassifyManifest('<classify><memory id="1" safety_critical="true"/></classify>'),
    ).toEqual([{ id: 1, safety_critical: true }]);
    expect(() =>
        parseClassifyManifest(
            '<classify><memory id="1" importance="40" safety_critical="null"/></classify>',
        ),
    ).toThrow("invalid safety_critical");
});

test("normal classify flags historian-scored, legacy-classified and open-item rules without reclassifying metadata", async () => {
    const f = fixture();
    try {
        const [scored, legacy, open] = f.rows;
        f.db.prepare("UPDATE memories SET scope='ecosystem',shareable=0").run();
        const item = f.enqueue(scored.id);
        recordItemScores(f.db, [item], [{ item, importance: 40, proposedClass: "durable" }]);
        setMemoryClassification(f.db, legacy.id, { importance: 95 });
        f.enqueue(open.id);
        const selection = await classifySafetyFixture(f.db, f.project);
        expect(selection.result.classified).toBe(10);
        expect(selection.prompted).toEqual(expect.arrayContaining([scored.id, legacy.id, open.id]));
        for (const [row, importance] of [
            [scored, 80],
            [legacy, 95],
            [open, 80],
        ] as const) {
            expect(getMemoryById(f.db, row.id)).toMatchObject({
                safetyCritical: 1,
                importance,
                scope: "ecosystem",
                shareable: 0,
            });
        }
        expect(getMemoryById(f.db, f.rows[3].id)).toMatchObject({
            safetyCritical: 0,
            importance: 1,
        });
        setMemoryClassification(f.db, scored.id, { importance: 10 });
        expect(getMemoryById(f.db, scored.id)).toMatchObject({ safetyCritical: 1, importance: 80 });
        updateMemoryContent(
            f.db,
            scored.id,
            "Never push without explicit approval.",
            "updated-safety-rule",
        );
        expect(getMemoryById(f.db, scored.id)?.safetyCritical).toBe(1);
    } finally {
        f.db.close();
    }
});

test("host classify selection matches the shared scored legacy and open-rule fixture", async () => {
    const f = fixture();
    try {
        const [scored, legacy, open] = f.rows;
        f.db.exec("UPDATE memories SET scope='ecosystem',shareable=0,source_type='historian'");
        const item = f.enqueue(scored.id);
        recordItemScores(f.db, [item], [{ item, importance: 40, proposedClass: "durable" }]);
        f.db.prepare("UPDATE memories SET classified_at=2 WHERE id=?").run(scored.id);
        f.db.prepare("UPDATE memories SET importance=95,classified_at=1 WHERE id=?").run(legacy.id);
        f.enqueue(open.id);
        expect(
            f.db
                .prepare(
                    "SELECT id AS memory_id,importance,classified_at FROM memories ORDER BY id",
                )
                .all(),
        ).toEqual(selectionCase.scored_inputs);
        const selection = await classifySafetyFixture(f.db, f.project);
        expect(selection.result).toMatchObject(selectionCase.result);
        expect(selection.prompted.sort((a, b) => a - b)).toEqual(selectionCase.prompted);
        for (const row of selectionCase.rows) {
            expect(getMemoryById(f.db, row.memory_id)).toMatchObject({
                safetyCritical: row.safety_critical ? 1 : 0,
                importance: row.memory_id === legacy.id ? 95 : row.safety_critical ? 80 : 1,
                scope: row.memory_id <= open.id ? "ecosystem" : "universe",
                shareable: row.memory_id <= open.id ? 0 : 1,
            });
        }
    } finally {
        f.db.close();
    }
});

test("large-pool safety assessments are not also shown as classified anchors", async () => {
    const f = fixture();
    try {
        for (let i = 10; i < 101; i++) {
            insertMemory(f.db, {
                projectPath: f.project,
                category: "ARCHITECTURE",
                content: `Extra ordinary fact ${i}.`,
            });
        }
        f.db.exec("UPDATE memories SET classified_at=1,safety_critical=0");
        const ids = f.rows.slice(0, 3).map((row) => row.id);
        for (const id of ids)
            f.db
                .prepare("UPDATE memories SET safety_critical=NULL,importance=40 WHERE id=?")
                .run(id);
        const selection = await classifySafetyFixture(f.db, f.project);
        expect(selection.result).toMatchObject({ stage: 3, classified: 3, remaining: 0 });
        expect(selection.prompted.sort((a, b) => a - b)).toEqual(ids);
        expect(selection.anchorIds.length).toBeGreaterThan(0);
        expect(selection.anchorIds.some((id) => ids.includes(id))).toBe(false);
        for (const id of ids)
            expect(getMemoryById(f.db, id)).toMatchObject({ safetyCritical: 1, importance: 80 });
    } finally {
        f.db.close();
    }
});

test("historian scores share the Rust safety floor corpus and never assess safety", () => {
    const f = fixture();
    try {
        for (const [i, sample] of scoreCases.entries()) {
            const id = f.rows[i].id;
            if (sample.flag !== null)
                setMemoryClassification(f.db, id, { safetyCritical: sample.flag });
            const item = f.enqueue(id);
            const score = { item, importance: sample.score, proposedClass: "free-form" };
            expect(recordItemScores(f.db, [item], [score])).toBe(1);
            expect(getMemoryById(f.db, id)).toMatchObject({
                importance: sample.expected,
                safetyCritical: sample.flag === null ? null : Number(sample.flag),
            });
            expect(recordItemScores(f.db, [item], [{ ...score, importance: 1 }])).toBe(0);
            expect(
                f.db
                    .prepare(
                        "SELECT importance,proposed_class FROM memory_classification_items WHERE enqueue_sequence=?",
                    )
                    .get(item),
            ).toEqual({ importance: sample.score, proposed_class: "free-form" });
        }
        const item = f.enqueue(f.rows[5].id);
        expect(
            recordItemScores(f.db, [], [{ item, importance: 1, proposedClass: "ignored" }]),
        ).toBe(0);
    } finally {
        f.db.close();
    }
});

test("classify migration leaves every existing memory safety assessment NULL", () => {
    const f = fixture();
    try {
        f.db.exec(
            "ALTER TABLE memories DROP COLUMN safety_critical; DELETE FROM schema_migrations WHERE version=104",
        );
        runMigrations(f.db);
        expect(
            f.db.prepare("SELECT count(*) n FROM memories WHERE safety_critical IS NULL").get(),
        ).toEqual({ n: 10 });
    } finally {
        f.db.close();
    }
});
