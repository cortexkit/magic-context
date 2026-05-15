/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi key-files v6 parity.
 *
 * OpenCode's unit/e2e coverage proves the Dreamer writer can validate and
 * commit `project_key_files` rows. Pi cannot drive that writer from the e2e
 * harness, so this test seeds the shared SQLite tables directly and verifies
 * the Pi-specific end-to-end path:
 *
 *   1. `project_key_files` + `project_key_files_version` are written for the
 *      Pi workdir project identity.
 *   2. Pi's `before_agent_start` system-prompt injector renders the shared
 *      `<key-files>` block into the model request.
 *   3. Replacing rows and bumping `project_key_files_version` refreshes the
 *      per-session cached block on a later turn.
 *
 * The mock provider is shared with OpenCode e2e, so
 * `h.mock.lastRequest()?.body.system` is the canonical observation point.
 */

function sha256(input: string | Buffer): string {
    return createHash("sha256").update(input).digest("hex");
}

function systemPrompt(h: PiTestHarness): string {
    const system = h.mock.lastRequest()?.body.system;
    if (typeof system === "string") return system;
    // Pi sends system as an array of `{ type: "text", text: "..." }` blocks.
    // Join the unescaped `text` fields so test assertions can match the
    // original XML/markdown content rather than its JSON-escaped form.
    if (Array.isArray(system)) {
        return system
            .map((b: unknown) => {
                if (b && typeof b === "object" && "text" in b) {
                    const t = (b as { text: unknown }).text;
                    return typeof t === "string" ? t : "";
                }
                return "";
            })
            .join("\n");
    }
    return JSON.stringify(system ?? "");
}

function openSeedDb(sharedDataDir: string): { db: Database; dbPath: string } {
    const dir = join(sharedDataDir, "cortexkit", "magic-context");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "context.db");
    const db = new Database(dbPath, { create: true, readwrite: true });
    initializeDatabase(db);
    runMigrations(db);
    return { db, dbPath };
}

function replaceKeyFiles(args: {
    dbPath: string;
    projectPath: string;
    files: Array<{ path: string; disk: string; injected: string; tokens?: number }>;
}): number {
    const projectPath = args.projectPath;
    const db = new Database(args.dbPath, { readwrite: true });
    try {
        db.exec("BEGIN IMMEDIATE");
        db.prepare("DELETE FROM project_key_files WHERE project_path = ?").run(projectPath);
        const now = Date.now();
        const insert = db.prepare(
            `INSERT INTO project_key_files
               (project_path, path, content, content_hash, local_token_estimate,
                generated_at, generated_by_model, generation_config_hash, stale_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        );
        for (const file of args.files) {
            const diskPath = join(projectPath, file.path);
            mkdirSync(dirname(diskPath), { recursive: true });
            writeFileSync(diskPath, file.disk);
            insert.run(
                projectPath,
                file.path,
                file.injected,
                sha256(file.disk),
                file.tokens ?? 16,
                now,
                "pi-key-files-v6-test",
                "pi-key-files-v6-config",
            );
        }
        db.prepare(
            `INSERT INTO project_key_files_version (project_path, version)
             VALUES (?, 1)
             ON CONFLICT(project_path) DO UPDATE SET version = version + 1`,
        ).run(projectPath);
        const row = db
            .prepare("SELECT version FROM project_key_files_version WHERE project_path = ?")
            .get(projectPath) as { version: number };
        db.exec("COMMIT");
        return row.version;
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // no active transaction
        }
        throw error;
    } finally {
        db.close();
    }
}

describe("pi key-files v6", () => {
    it("injects shared project_key_files rows and refreshes when the version bumps", async () => {
        const sharedDataDir = mkdtempSync(join(tmpdir(), "pi-kf-data-"));
        // realpath workdir so seeded project_path matches what
        // `resolveProjectPath()` (via `realpathSync`) computes when Pi
        // looks up rows at runtime. On macOS `tmpdir()` returns
        // `/var/folders/...` but the actual path is
        // `/private/var/folders/...`.
        const workdir = realpathSync(mkdtempSync(join(tmpdir(), "pi-kf-work-")));
        const { db, dbPath } = openSeedDb(sharedDataDir);
        db.close();

        const firstVersion = replaceKeyFiles({
            dbPath,
            projectPath: workdir,
            files: [
                {
                    path: "src/important.ts",
                    disk: "export const important = 'v1';\n",
                    injected: "important outline v1 for Pi system prompt",
                },
            ],
        });
        expect(firstVersion).toBe(1);

        const h = await PiTestHarness.create({
            sharedDataDir,
            workdir,
            piSettingsExtra: { extensions: ["@cortexkit/aft-pi"] },
            magicContextConfig: {
                dreamer: {
                    enabled: true,
                    inject_docs: false,
                    user_memories: { enabled: false },
                    pin_key_files: { enabled: true, token_budget: 2_000 },
                },
            },
        });
        try {
            await h.sendPrompt("read the seeded Pi key files", { timeoutMs: 60_000 });
            let system = systemPrompt(h);
            expect(system).toContain("<key-files>");
            expect(system).toContain('path="src/important.ts"');
            expect(system).toContain("important outline v1 for Pi system prompt");

            const secondVersion = replaceKeyFiles({
                dbPath,
                projectPath: workdir,
                files: [
                    {
                        path: "src/important.ts",
                        disk: "export const important = 'v2';\n",
                        injected: "important outline v2 after Pi version bump",
                    },
                ],
            });
            expect(secondVersion).toBe(2);

            await h.sendPrompt("read the refreshed Pi key files", { timeoutMs: 60_000 });
            system = systemPrompt(h);
            expect(system).toContain("<key-files>");
            expect(system).toContain("important outline v2 after Pi version bump");
            expect(system).not.toContain("important outline v1 for Pi system prompt");
        } finally {
            await h.dispose();
            rmSync(sharedDataDir, { recursive: true, force: true });
            rmSync(workdir, { recursive: true, force: true });
        }
    }, 120_000);
});
