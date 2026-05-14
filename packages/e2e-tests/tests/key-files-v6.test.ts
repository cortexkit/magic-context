/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../plugin/src/shared/sqlite";
import { closeQuietly } from "../../plugin/src/shared/sqlite-helpers";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { setDreamState } from "../../plugin/src/features/magic-context/dreamer/storage-dream-state";
import { setAftAvailabilityOverride } from "../../plugin/src/features/magic-context/key-files/aft-availability";
import { getKeyFilesVersion, readCurrentKeyFiles } from "../../plugin/src/features/magic-context/key-files/project-key-files";
import { commitKeyFiles, validateLlmOutput } from "../../plugin/src/features/magic-context/key-files/identify-key-files";
import { readVersionedKeyFiles } from "../../plugin/src/hooks/magic-context/key-files-block";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function seedLease(db: Database): void {
    setDreamState(db, "dreaming_lease_holder", "holder");
    setDreamState(db, "dreaming_lease_expiry", String(Date.now() + 60_000));
}

describe("key-files v6 e2e invariants", () => {
    it("commits rows with version=1, injects them, and second commit bumps to version=2", () => {
        setAftAvailabilityOverride(true);
        const db = makeDb();
        const project = mkdtempSync(join(tmpdir(), "kf-e2e-"));
        try {
            writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
            seedLease(db);
            const first = validateLlmOutput(
                JSON.stringify({ no_change: false, files: [{ path: "a.ts", content: "outline a", approx_token_estimate: 8 }] }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            );
            expect(commitKeyFiles({ db, projectPath: project, validated: first, configHash: "cfg", modelId: "model", leaseHolderId: "holder" })).toBe(1);
            expect(getKeyFilesVersion(db, project)).toBe(1);
            expect(readCurrentKeyFiles(db, project)).toHaveLength(1);

            const sessionMeta = { sessionId: "s", isSubagent: false } as import("../../plugin/src/features/magic-context/types").SessionMeta;
            const injected = readVersionedKeyFiles({
                db,
                sessionId: "s",
                sessionMeta,
                directory: project,
                isCacheBusting: false,
                config: { enabled: true, tokenBudget: 2000 },
            });
            expect(injected).toContain("<key-files>");
            expect(injected).toContain("outline a");

            seedLease(db);
            const second = validateLlmOutput(
                JSON.stringify({ no_change: false, files: [{ path: "a.ts", content: "outline a v2", approx_token_estimate: 8 }] }),
                { enabled: true, token_budget: 2000, min_reads: 2 },
                project,
            );
            expect(commitKeyFiles({ db, projectPath: project, validated: second, configHash: "cfg", modelId: "model", leaseHolderId: "holder" })).toBe(2);
            expect(readVersionedKeyFiles({
                db,
                sessionId: "s",
                sessionMeta,
                directory: project,
                isCacheBusting: false,
                config: { enabled: true, tokenBudget: 2000 },
            })).toContain("outline a v2");
        } finally {
            setAftAvailabilityOverride(null);
            closeQuietly(db);
            rmSync(project, { recursive: true, force: true });
        }
    });
});
