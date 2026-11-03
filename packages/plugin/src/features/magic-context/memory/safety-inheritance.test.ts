import { expect, test } from "bun:test";
import cases from "../../../../../../crates/mc-store/testdata/s02-merge-safety-cases.json";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { mergeProjectIdentities } from "../storage-identity-merge";
import { applyAgentMemoryMutation, applyCurateMemoryMutation } from "./lifecycle-applier";
import { getMemoryById, insertMemory } from "./storage-memory";

for (const sample of cases) {
    for (const [writer, apply] of [
        ["agent", applyAgentMemoryMutation],
        ["curate", applyCurateMemoryMutation],
    ] as const) {
        if (writer === "agent" && sample.archivedSource !== undefined) continue;
        for (const reuseSource of [false, true]) {
            test(`s02 merge parity: ${sample.name}, ${writer}, ${reuseSource ? "existing" : "new"} canonical`, () => {
                const db = new Database(":memory:");
                try {
                    initializeDatabase(db);
                    runMigrations(db);
                    const sources = sample.flags.map((flag, index) => {
                        const memory = insertMemory(db, {
                            projectPath: "git:safety-parity",
                            category: "PROJECT_RULES",
                            content: `Source ${index} for ${sample.name}.`,
                        });
                        db.prepare(
                            "UPDATE memories SET safety_critical=?,importance=?,status=? WHERE id=?",
                        ).run(
                            flag === null ? null : Number(flag),
                            flag === true ? 80 : 50,
                            sample.archivedSource === index ? "archived" : "active",
                            memory.id,
                        );
                        return memory;
                    });
                    const receipt = apply(db, {
                        key: "merge-parity",
                        projectPath: "git:safety-parity",
                        sourceSessionId: "ses-parity",
                        operation: "merge",
                        targets: sources.map((source) => ({ id: source.id, revision: 1 })),
                        content: reuseSource
                            ? sources[0]!.content
                            : sources.map((source) => source.content).join(" "),
                    });
                    expect(receipt.state).toBe("applied");
                    expect(getMemoryById(db, receipt.memoryId!)).toMatchObject({
                        safetyCritical: sample.expected === null ? null : Number(sample.expected),
                        importance: sample.importance,
                    });
                } finally {
                    db.close();
                }
            });
        }
    }

    for (const newerSource of [false, true]) {
        test(`s02 identity parity: ${sample.name}, source ${newerSource ? "newer" : "older"}`, () => {
            const db = new Database(":memory:");
            try {
                initializeDatabase(db);
                runMigrations(db);
                const sources = sample.flags.map((flag, index) => {
                    const memory = insertMemory(db, {
                        projectPath: index === 0 ? "git:target" : `dir:source-${index}`,
                        category: "PROJECT_RULES",
                        content: "Identical rule for identity reconciliation.",
                    });
                    db.prepare(
                        "UPDATE memories SET safety_critical=?,importance=?,classified_at=?,status=? WHERE id=?",
                    ).run(
                        flag === null ? null : Number(flag),
                        flag === true ? 80 : 50,
                        newerSource ? index + 1 : sample.flags.length - index,
                        sample.archivedSource === index ? "archived" : "active",
                        memory.id,
                    );
                    return memory;
                });
                for (let index = 1; index < sources.length; index++) {
                    mergeProjectIdentities(db, `dir:source-${index}`, "git:target", { now: 100 });
                }
                expect(getMemoryById(db, sources[0]!.id)).toMatchObject({
                    safetyCritical: sample.expected === null ? null : Number(sample.expected),
                    importance: sample.importance,
                });
            } finally {
                db.close();
            }
        });
    }
}

test("s02 identity copy preserves importance above the safety floor", () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        const target = insertMemory(db, {
            projectPath: "git:target",
            category: "PROJECT_RULES",
            content: "Never delete backups.",
        });
        const source = insertMemory(db, {
            projectPath: "dir:old",
            category: "PROJECT_RULES",
            content: target.content,
        });
        db.prepare(
            "UPDATE memories SET safety_critical=1,importance=80,classified_at=1 WHERE id=?",
        ).run(target.id);
        db.prepare(
            "UPDATE memories SET safety_critical=0,importance=95,classified_at=2 WHERE id=?",
        ).run(source.id);
        mergeProjectIdentities(db, "dir:old", "git:target", { now: 100 });
        expect(getMemoryById(db, target.id)).toMatchObject({ safetyCritical: 1, importance: 95 });
    } finally {
        db.close();
    }
});
