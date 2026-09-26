/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { ensureContextStoreUuid } from "../context-authority";
import { insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { archiveExpiredMemories } from "./expire-memories";
import { acquireLeaseWithAcquisition } from "./lease";
import type { DreamerModuleRoute } from "./module-apply";
import { leaseKeyFor } from "./task-registry";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("archiveExpiredMemories", () => {
    test("routes module-owned expiry through ctx_memory and mirrors the archive status", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const project = "/repo/module-expiry";
        const now = Date.now();
        const memory = insertMemory(db, {
            projectPath: project,
            category: "KNOWN_ISSUES",
            content: "A module-owned TTL memory.",
            expiresAt: now - 1,
        });
        const contextStoreUuid = ensureContextStoreUuid(db);
        db.prepare(
            "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
        ).run(project, 77, memory.id);
        db.prepare(
            `INSERT INTO mirror_live_memory_rows(
                module_project, module_row_id, category, normalized_hash, full_row_snapshot
             ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
            project,
            77,
            memory.category,
            memory.normalizedHash,
            JSON.stringify({
                id: 77,
                project_path: project,
                category: memory.category,
                content: memory.content,
                normalized_hash: memory.normalizedHash,
                status: "active",
                expires_at: memory.expiresAt,
                updated_at: memory.updatedAt,
            }),
        );
        const call = mock(async () => ({ result: { ok: true } }));
        const mirrorPull = mock(
            async (request: {
                domain: "memories" | "notes";
                cursor: number;
                limit: number;
                project: string;
                projectRoot?: string;
            }) => ({
                page: {
                    domain: "memories" as const,
                    cursor: request.cursor,
                    next_cursor: 1,
                    has_more: false,
                    rows: [
                        {
                            feed_seq: 1,
                            domain: "memories" as const,
                            op: "update" as const,
                            module_row_id: 77,
                            full_row_snapshot: {
                                project_path: project,
                                status: "archived",
                                metadata_json: JSON.stringify({ archive_reason: "expired" }),
                                updated_at: now + 1,
                            },
                            content_hash: memory.normalizedHash,
                        },
                    ],
                },
            }),
        );
        const moduleRoute: DreamerModuleRoute = {
            moduleClient: { call, mirrorPull, markerStatus: async () => ({ ok: true }) },
            moduleSessionId: project,
            moduleProjectRoot: project,
            moduleContextStoreUuid: contextStoreUuid,
            moduleAuthorityGeneration: 4,
            moduleCommandId: "curate-expiry",
        };
        const holderId = "module-expiry-holder";
        const leaseKey = leaseKeyFor("curate", project);
        const leaseAcquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
        expect(leaseAcquisition).not.toBeNull();

        const archived = await archiveExpiredMemories({
            db,
            projectIdentity: project,
            holderId,
            leaseKey,
            leaseAcquisition: leaseAcquisition!,
            now,
            moduleRoute,
        });

        expect(archived).toBe(1);
        expect(call).toHaveBeenCalledWith({
            sessionId: project,
            projectRoot: project,
            method: "ctx_memory",
            body: {
                name: "ctx_memory",
                arguments: {
                    action: "archive",
                    memory_project: project,
                    ids: [77],
                    reason: "expired",
                    command_id: "curate-expiry:expire:0",
                },
            },
        });
        expect(mirrorPull).toHaveBeenCalledWith({
            domain: "memories",
            cursor: 0,
            limit: 1_000,
            // The dreamer's identity for the project reaches the module verbatim.
            project,
            projectRoot: project,
        });
        expect(
            db.prepare("SELECT status, metadata_json FROM memories WHERE id = ?").get(memory.id),
        ).toEqual({
            status: "archived",
            metadata_json: JSON.stringify({ archive_reason: "expired" }),
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get()).toEqual({
            count: 0,
        });
    });
});
