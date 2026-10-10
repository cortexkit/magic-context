import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { HostFoldPolicy } from "./policy";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});
function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    let cut: StoreRow<"compaction"> | undefined;
    let rows = 1000;
    const logs: string[] = [];
    const calls: Array<{ sessionID: string; id?: string; delivery?: string }> = [];
    const storage = nativeFoldCache(db);
    const reader = {
        latestCompaction: () => cut,
        latestSequence: () => 1000,
        storedRowsAfter: () => rows,
        close() {},
    } as unknown as V2StoreReader;
    const deps = {
        canReplay: async () => true,
        storage,
        threshold: 1000,
        openReader: () => reader,
        log: (_sid: string, line: string) => logs.push(line),
        session: {
            compact: async (input: {
                sessionID: string;
                id?: string;
                delivery?: "queue" | "steer";
            }) => {
                calls.push(input);
                await storage.supply(
                    "s",
                    input.id!,
                    JSON.stringify({
                        source: storage.sourceID,
                        sessionID: "s",
                        admissionID: input.id,
                        summary: "owned summary",
                    }),
                );
                return { id: "foreign-provider-cut" };
            },
            wait: async () => {
                cut = {
                    id: "foreign-provider-cut",
                    seq: 1001,
                    session_id: "s",
                    type: "compaction",
                    data: {
                        status: "completed",
                        summary: "foreign summary",
                        providerContext: { opaque: true },
                    },
                };
                rows = 1;
            },
        },
    };
    return { deps, calls, logs, db };
}

test("review: a foreign provider checkpoint does not settle an owned automatic nomination", async () => {
    const f = fixture();
    await new HostFoldPolicy(f.deps).idle("s");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.delivery).toBe("queue");
    // A host can coalesce the queue request onto an already pending request.
    // A later checkpoint sequence does not prove that this instance answered the
    // requested compaction; its returned id and supplied summary must match too.
    expect(f.logs.some((line) => line.includes("status=completed"))).toBe(false);
});

test("review: two policy instances log one settled nomination rather than two completions", async () => {
    const f = fixture();
    // Both callers see the previous checkpoint. The host can return one pending
    // compaction for their two requests rather than execute both independently.
    const policies = [new HostFoldPolicy(f.deps), new HostFoldPolicy(f.deps)];
    // Both continuations must see the same completed compaction boundary.
    let settled = false;
    const oldReader = f.deps.openReader();
    f.deps.openReader = () =>
        settled
            ? ({
                  latestCompaction: () => ({
                      id: f.calls[0]!.id,
                      seq: 1001,
                      session_id: "s",
                      type: "compaction",
                      data: { status: "completed", summary: "owned summary" },
                  }),
                  storedRowsAfter: () => 1,
                  close() {},
              } as unknown as V2StoreReader)
            : oldReader;
    f.deps.session.compact = async (input) => {
        f.calls.push(input);
        await f.deps.storage.supply(
            "s",
            input.id!,
            JSON.stringify({
                source: f.deps.storage.sourceID,
                sessionID: "s",
                admissionID: input.id,
                summary: "owned summary",
            }),
        );
        return { id: input.id! };
    };
    f.deps.session.wait = async () => {
        settled = true;
    };
    await Promise.all(policies.map((policy) => policy.idle("s")));
    expect(f.logs.filter((line) => line.includes("status=completed"))).toHaveLength(1);
});

test("review control: a short session stays below the default stored-row threshold", async () => {
    const f = fixture();
    f.deps.openReader = () =>
        ({
            latestCompaction: () => undefined,
            storedRowsAfter: () => 999,
            close() {},
        }) as unknown as V2StoreReader;
    await new HostFoldPolicy(f.deps).idle("s");
    expect(f.calls).toEqual([]);
    expect(f.logs).toEqual([]);
});
