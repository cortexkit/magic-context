
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@magic-context/core/shared/sqlite";
import { projectDirectoryKey } from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import { observations } from "./doctor-merge-identity";
import { __compatPinUpdates } from "./doctor-project-ids-apply";

test("deployed doctor project-ids reader tolerates additive via without rewriting", () => {
    const root = mkdtempSync(join(tmpdir(), "deployed-doctor-via-"));
    try {
        const directory = projectDirectoryKey(join(root, "folder"));
        mkdirSync(directory);
        mkdirSync(join(directory, ".git"));
        const common = join(directory, ".git");
        const sidecars = join(root, "project-identities");
        mkdirSync(sidecars);
        const file = join(sidecars, `${createHash("sha256").update(directory).digest("hex")}.json`);
        const bytes = JSON.stringify({ directory, identity: "pj-registered", gitCommonDir: common, via: "root" });
        writeFileSync(file, bytes);
        expect(__compatPinUpdates({ to: "pj-registered", folders: [{ directory }] } as never, root)).toEqual([]);
        expect(readFileSync(file, "utf8")).toBe(bytes);
    } finally { rmSync(root, { recursive: true }); }
});

test("deployed doctor merge reader keeps its git and pj interpretation with additive via", () => {
    const root = mkdtempSync(join(tmpdir(), "deployed-merge-via-"));
    const db = new Database(":memory:");
    try {
        db.exec("CREATE TABLE workspace_members (project_path TEXT, display_path TEXT)");
        const sidecars = join(root, "project-identities");
        mkdirSync(sidecars);
        writeFileSync(join(sidecars, "git.json"), JSON.stringify({ directory: "/fixture/legacy", identity: "git:abcdef123", via: "root" }));
        writeFileSync(join(sidecars, "pj.json"), JSON.stringify({ directory: "/fixture/root", identity: "pj-registered", via: "root" }));
        expect(observations(db, null, root).map(row => [row.directory, row.identities[0]?.identity])).toEqual([["/fixture/legacy", "git:abcdef123"]]);
    } finally { db.close(); rmSync(root, { recursive: true }); }
});
