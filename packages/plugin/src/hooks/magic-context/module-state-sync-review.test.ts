/// <reference types="bun-types" />
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    loadModuleWatermarks,
    type ModuleStateSyncState,
    syncModuleState,
} from "./module-state-sync";

const originalDataHome = process.env.XDG_DATA_HOME;
const originalLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;
const dirs: string[] = [];
const databases: Database[] = [];

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
    else process.env.MAGIC_CONTEXT_LOG_PATH = originalLogPath;
});

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "m3-sync-review-"));
    dirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_LOG_PATH = join(dir, "review.log");
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const pass = { db, sessionId: "review", nowMs: 1, historianModelChain: ["provider/a"] };
    const state: ModuleStateSyncState = {
        moduleGeneration: 1,
        lastAckedSeq: 0,
        lastAckedWatermarks: loadModuleWatermarks({
            db,
            sessionId: pass.sessionId,
            historianModelChain: pass.historianModelChain,
        }),
        idOrdinalMemoGeneration: 1,
        idOrdinalMemo: new Map(),
    };
    return { pass, state };
}

it("review no-change barrier does not swallow a module restart", async () => {
    const { pass, state } = fixture();
    const calls: Record<string, unknown>[] = [];
    const client = {
        getCachedStateSyncCapabilities: () => ({ state_sync_deltas: true }),
        async call(args: { body: unknown }) {
            const body = args.body as Record<string, unknown>;
            calls.push(body);
            if (calls.length === 1) {
                state.moduleGeneration = 2;
                return {
                    transport_status: "connection_generation_changed",
                    previous_generation: 1,
                    current_generation: 2,
                };
            }
            return { ok: true };
        },
    };
    const result = await syncModuleState({
        client,
        state,
        pass,
        projectRoot: "/review",
        force: false,
        options: { knownWatermarksUnchanged: true, passComplete: true },
    });
    expect(calls[0]).toEqual({ method: "state_sync", session_id: "review", pass_complete: true });
    expect(result.status).not.toBe("no_change");
    expect(calls.some((call, index) => index > 0 && call.historian_model_chain !== undefined)).toBe(
        true,
    );
});

it("review resumed completed seed still sends the current pass barrier", async () => {
    const { pass, state } = fixture();
    const calls: Record<string, unknown>[] = [];
    const client = {
        getCachedStateSyncCapabilities: () => ({
            state_sync_deltas: true,
            state_sync_resume: true,
        }),
        async call(args: { body: unknown }) {
            const body = args.body as Record<string, unknown>;
            calls.push(body);
            if (body.state_sync_inventory === true) {
                return {
                    state_sync_inventory: {
                        generation: 1,
                        max_compartment_sequence: -1,
                        boundary_id: null,
                        context_boundaries_resolved: true,
                    },
                };
            }
            if (typeof body.state_sync_seed_id === "string") {
                return {
                    state_sync: {
                        seed_id: body.state_sync_seed_id,
                        generation: 1,
                        completed: true,
                        shadow_seq: 1,
                    },
                };
            }
            return { ok: true };
        },
    };
    const result = await syncModuleState({
        client,
        state,
        pass,
        projectRoot: "/review",
        force: true,
        options: { passComplete: true },
    });
    expect(result.status).toBe("acked");
    // A durable receipt proves the seed data, not that this later pass was evaluated.
    expect(
        calls.filter((call) => call.method === "state_sync" && call.pass_complete === true),
    ).toHaveLength(1);
});
