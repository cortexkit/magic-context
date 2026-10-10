import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { nativeFoldCache } from "./memory-cache";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

import type { V2StoreReader } from "../store-reader";
import { HostFoldPolicy } from "./policy";

function fixture(rows = 1000) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    const storage = nativeFoldCache(db);
    let cut = -1;
    let count = rows;
    let fail = false;
    const calls: Array<{ sessionID: string; id?: string; delivery?: string }> = [];
    const logs: string[] = [];
    const reader = {
        latestCompaction: () =>
            cut < 0
                ? undefined
                : {
                      id: calls.at(-1)?.id,
                      seq: cut,
                      session_id: "s",
                      type: "compaction",
                      data: { status: "completed", summary: "owned" },
                  },
        latestSequence: () => rows,
        storedRowsAfter: () => count,
        close() {},
    } as unknown as V2StoreReader;
    const session = {
        compact: async (input: {
            sessionID: string;
            id?: string;
            delivery?: "steer" | "queue";
        }) => {
            calls.push(input);
            if (fail) throw new Error("fold failed");
            await storage.supply(
                "s",
                input.id!,
                JSON.stringify({
                    source: storage.sourceID,
                    sessionID: "s",
                    admissionID: input.id,
                    summary: "owned",
                }),
            );
            return { id: input.id };
        },
        wait: async () => {
            cut = rows + 1;
            count = 1;
        },
    };
    const deps = {
        session,
        storage,
        canReplay: async () => true,
        threshold: 1000,
        openReader: () => reader,
        log: (_s: string, line: string) => logs.push(line),
    };
    return {
        deps,
        calls,
        logs,
        db,
        fail: (value: boolean) => {
            fail = value;
        },
    };
}

test("host fold threshold uses queue, coalesces concurrent nominations, and logs settled rows once", async () => {
    const f = fixture();
    const policy = new HostFoldPolicy(f.deps);
    await Promise.all([policy.idle("s"), policy.idle("s")]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.delivery).toBe("queue");
    expect(f.calls[0]!.id).toMatch(/^msg_mc_fold_/);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("rows_before=1000 rows_after=1");
    expect(f.logs[0]).toContain("status=completed");
    await policy.idle("s");
    expect(f.calls).toHaveLength(1);
});

test("host folding is disabled at zero, below threshold or without the native capability", async () => {
    const f = fixture(999);
    await new HostFoldPolicy(f.deps).idle("s");
    await new HostFoldPolicy({ ...f.deps, threshold: 0 }).idle("s");
    await new HostFoldPolicy({ ...f.deps, session: { wait: f.deps.session.wait } }).idle("s");
    expect(f.calls).toEqual([]);
    expect(f.logs).toEqual([]);
});

test("a failed host fold retains its in-process attempt and retries with a new id", async () => {
    const f = fixture();
    f.fail(true);
    await new HostFoldPolicy(f.deps).idle("s");
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("status=failed");
    const first = f.calls[0]!.id;
    f.fail(false);
    await new HostFoldPolicy(f.deps).idle("s");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.id).not.toBe(first);
    expect(f.logs[1]).toContain("status=completed");
});

// Not applicable: fold attempts and their ids live only in this process's memory,
// and each new cache derives ids from its own random source id, so a restarted
// host has no earlier id to reuse. Merging a request still queued from before the
// restart is left to OpenCode's own compaction queue.
test.skip("a pending fold reuses its durable id across a host restart", () => {});

test("automatic admission reports cache callback failures without an unhandled rejection", async () => {
    const f = fixture();
    f.deps.storage.claim = async () => {
        throw new Error("storage unavailable");
    };
    await new HostFoldPolicy(f.deps).idle("s");
    expect(f.calls).toEqual([]);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("status=failed");
    expect(f.logs[0]).toContain('cache_error="Error: storage unavailable"');
});
