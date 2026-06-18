import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { promoteSkillObservations } from "./promote";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("promoteSkillObservations", () => {
    test("direct-writes a global '*' note with historian provenance", () => {
        const db = makeDb();
        try {
            const n = promoteSkillObservations(db, "git:repoA", [
                { skillId: "council", kind: "gotcha", lesson: "aggregator needs a fast model" },
            ]);
            expect(n).toBe(1);
            const row = db.prepare("SELECT tier, project_identity, origin_project, source_type, resolved_path, kind FROM skill_memory").get() as Record<
                string,
                string
            >;
            expect(row.tier).toBe("global");
            expect(row.project_identity).toBe("*");
            expect(row.origin_project).toBe("git:repoA");
            expect(row.source_type).toBe("historian");
            expect(row.resolved_path).toBe("");
            expect(row.kind).toBe("gotcha");
        } finally {
            closeQuietly(db);
        }
    });

    test("exact-hash duplicate bumps hit_count instead of inserting", () => {
        const db = makeDb();
        try {
            promoteSkillObservations(db, "git:repoA", [{ skillId: "council", kind: "fix", lesson: "same lesson" }]);
            const n = promoteSkillObservations(db, "git:repoB", [{ skillId: "council", kind: "fix", lesson: "same lesson" }]);
            expect(n).toBe(0);
            const rows = db.prepare("SELECT hit_count FROM skill_memory").all() as Array<{ hit_count: number }>;
            expect(rows.length).toBe(1);
            expect(rows[0].hit_count).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects kind='general'", () => {
        const db = makeDb();
        try {
            const n = promoteSkillObservations(db, "git:repoA", [{ skillId: "council", kind: "general" as never, lesson: "x" }]);
            expect(n).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});
