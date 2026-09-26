/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
    type AuthorityStatus,
    getAuthorityManagedMarker,
    installAuthorityManagedMarker,
} from "../../features/magic-context/context-authority";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getProjectState } from "../../features/magic-context/storage-project-state";
import { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";
import { recoverTsAuthorityProject, scheduleTsAuthorityRecovery } from "./transform";

const PROJECT = "git:flip-back";

function status(domain: "memories" | "notes", state: AuthorityStatus["state"]): AuthorityStatus {
    return {
        context_store_uuid: "store",
        project: PROJECT,
        domain,
        state,
        generation: 1,
        captured_upper_bound: 0,
        coordinator_token: "drain-token",
    };
}

describe("TS authority flip-back", () => {
    test("a linked worktree never schedules a drain while a primary checkout does", async () => {
        const linkedProject = "git:linked-flip-back";
        const primaryProject = "git:primary-flip-back";
        const database = new Database(":memory:");
        initializeDatabase(database);
        runMigrations(database);
        installAuthorityManagedMarker(database, linkedProject);
        installAuthorityManagedMarker(database, primaryProject);

        const states = new Map<string, AuthorityStatus["state"]>([
            [`${linkedProject}:memories`, "MODULE"],
            [`${linkedProject}:notes`, "MODULE"],
            [`${primaryProject}:memories`, "MODULE"],
            [`${primaryProject}:notes`, "MODULE"],
        ]);
        const drainBegins: string[] = [];
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => ({
                authority: {
                    context_store_uuid: "store",
                    project: args.project,
                    domain: args.domain,
                    state: states.get(`${args.project}:${args.domain}`) ?? "TS",
                    generation: 1,
                },
            }),
            authorityPrepare: async (args) => ({
                authority: {
                    context_store_uuid: "store",
                    project: args.project,
                    domain: args.domain,
                    state: "MODULE",
                    generation: 1,
                },
            }),
            authorityDrain: async (args) => {
                if (args.action === "begin") drainBegins.push(args.project);
                const nextState = args.action === "finish" ? "TS" : "DRAINING";
                states.set(`${args.project}:${args.domain}`, nextState);
                return {
                    authority: {
                        context_store_uuid: "store",
                        project: args.project,
                        domain: args.domain,
                        state: nextState,
                        generation: 1,
                        captured_upper_bound: 0,
                        coordinator_token: "drain-token",
                    },
                };
            },
            markerStatus: async () => ({ ok: true }),
            mirrorPull: async (args) => ({
                page: {
                    domain: args.domain,
                    cursor: args.cursor,
                    next_cursor: args.cursor,
                    has_more: false,
                    rows: [],
                },
            }),
        };

        scheduleTsAuthorityRecovery({
            db: database,
            projectPath: linkedProject,
            projectRoot: "/repo/linked",
            module,
            isLinkedWorktree: () => true,
        });
        scheduleTsAuthorityRecovery({
            db: database,
            projectPath: primaryProject,
            projectRoot: "/repo/primary",
            module,
            isLinkedWorktree: () => false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(drainBegins).toEqual([primaryProject, primaryProject]);
        expect(getAuthorityManagedMarker(database, linkedProject)).not.toBeNull();
        expect(getAuthorityManagedMarker(database, primaryProject)).toBeNull();
        database.close();
    });

    test("drains real authority protocol, removes the marker, and bumps the memory epoch once", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        installAuthorityManagedMarker(db, PROJECT);
        const states = new Map<"memories" | "notes", AuthorityStatus["state"]>([
            ["memories", "MODULE"],
            ["notes", "MODULE"],
        ]);
        const roots: string[] = [];
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => {
                roots.push(String(args.projectRoot));
                return { authority: status(args.domain, states.get(args.domain) ?? "TS") };
            },
            authorityPrepare: async () => ({ authority: status("memories", "MODULE") }),
            authorityDrain: async (args) => {
                const domain = String(args.domain) as "memories" | "notes";
                if (args.action === "finish") states.set(domain, "TS");
                else states.set(domain, "DRAINING");
                return { authority: status(domain, states.get(domain) ?? "TS") };
            },
            markerStatus: async () => ({ ok: true }),
            mirrorPull: async (args) => ({
                page: {
                    domain: args.domain,
                    cursor: args.cursor,
                    next_cursor: args.cursor,
                    has_more: false,
                    rows: [],
                },
            }),
        };

        await expect(
            recoverTsAuthorityProject({
                db,
                projectPath: PROJECT,
                projectRoot: "/repo-root",
                module,
            }),
        ).resolves.toBe("completed");

        expect(getAuthorityManagedMarker(db, PROJECT)).toBeNull();
        expect(getProjectState(db, PROJECT)?.projectMemoryEpoch).toBe(1);
        expect(roots.every((root) => root === "/repo-root")).toBe(true);
        expect(() =>
            insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "writes are unfenced after the drain",
                sourceSessionId: "ses-flip-back",
            }),
        ).not.toThrow();
        db.close();
    });
});
