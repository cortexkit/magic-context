// Guards for the OpenCode 2 busy-database replay (the saved last good request
// served again when Magic Context's database is busy): the replay's tool list
// in a subagent session, and how the stored message times are read.
import { Database as BunDatabase } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as models from "../../shared/models-dev-cache";
import { messageTimesQuery, V2StoreReader } from "../store-reader";
import {
    installBusyAdmission,
    installTransientFailure,
    lkgEvents,
    oc2ContextFixture,
    prose,
} from "./__tests__/oc2-context.fixture";
import * as contextModule from "./context";
import type { SessionContext, V2Context } from "./types";

const AREA = "oc2-replay";

/**
 * Register the real context hook with `mutate` applied to every context draft
 * before the hook sees it, so a test can hand the hook tools the fixture's
 * host does not send.
 */
function withDraftMutation(mutate: (draft: SessionContext) => void) {
    const realRegister = contextModule.registerContext;
    return spyOn(contextModule, "registerContext").mockImplementation((async (ctx: V2Context) => {
        const session = ctx.session as unknown as Record<string, unknown> & {
            hook: (name: string, cb: (draft: SessionContext) => Promise<void>) => Promise<void>;
        };
        return realRegister({
            ...ctx,
            session: {
                ...session,
                hook: (name: string, cb: (draft: SessionContext) => Promise<void>) =>
                    session.hook(
                        name,
                        name === "context"
                            ? async (draft: SessionContext) => {
                                  mutate(draft);
                                  return cb(draft);
                              }
                            : cb,
                    ),
            },
        } as unknown as V2Context);
    }) as typeof realRegister);
}

// In a subagent session every healthy pass removes the primary-only tools
// (ctx_memory, ctx_note) from the request (hideSubagentTools, context.ts), and
// only after writer admission. A replay served at writer admission must send
// the same tool list as the saved request: tools come first in the provider's
// cached prefix, so any other list loses the cache on the turn the replay
// exists to keep cached, and offers the model two tools it may not call.
for (const busy of ["admission", "admission-exhausted"] as const)
    test(`OC2 replay: a subagent ${busy} replay sends the saved request's tool list`, async () => {
        const failure = installTransientFailure();
        const admission = installBusyAdmission();
        const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
        const register = withDraftMutation((draft) => {
            draft.tools = {
                ...draft.tools,
                ctx_memory: { description: "Memory", input: { type: "object" } },
                ctx_note: { description: "Notes", input: { type: "object" } },
            } as SessionContext["tools"];
        });
        const seed = busy === "admission" ? 9201 : 9202;
        const f = await oc2ContextFixture(seed, { area: AREA, instructions: false });
        try {
            // The host's session row names a parent: a subagent session.
            const host = new BunDatabase(process.env.OPENCODE_DB!);
            host.prepare("UPDATE session_v2 SET parent_id = 'ses-parent' WHERE id = ?").run(
                f.session,
            );
            host.close();
            f.compartment(4);
            await f.pass();
            f.respond();
            f.user(`${seed} the saved turn: ${prose}`, 120000);
            const saved = await f.pass();
            f.respond();
            f.user(`${seed} the busy turn: ${prose}`, 120000);
            expect(getSlot(f.session)).toBeDefined();
            expect(Object.keys(saved.draft.tools ?? {}).sort()).toEqual(["read"]);
            if (busy === "admission") admission.state.busyNext = true;
            else admission.state.exhaustNext = true;
            const replay = await f.attempt();
            expect(lkgEvents(replay.logs)).toBe("lkg_replay_served");
            expect(replay.draft.system).toEqual(saved.draft.system);
            // Without the subagent tool removal this is ["ctx_memory", "ctx_note", "read"].
            expect(Object.keys(replay.draft.tools ?? {}).sort()).toEqual(["read"]);
        } finally {
            register.mockRestore();
            admission.restore();
            failure.restore();
            limit.mockRestore();
            await f.cleanup();
        }
    }, 60000);

// The stored-times read filters on session_id and id. On the host's schema
// (built below) SQLite would rather use the (session_id, time_created, id)
// index than the primary key, and that index walks every row of the session
// for each batch of ids: about 0.9 s per pass for a 50,000-message session. The
// query plan must look the ids up through the primary key.
test("OC2 replay: the stored message times are read through the primary key", () => {
    const db = new BunDatabase(":memory:");
    try {
        // The OpenCode 2 store schema, as mirrored in dashboard/src-tauri/src/db.rs.
        db.exec(`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer, data text NOT NULL);
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
        CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
        CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id);
        CREATE INDEX session_message_time_created_idx ON session_message (time_created);`);
        // One long session. A host store normally has no planner statistics;
        // the plan is checked without them (where the session index wins) and
        // again after ANALYZE.
        const insert = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
        db.exec("BEGIN");
        for (let i = 0; i < 20000; i++)
            insert.run(`m${i}`, "long", "user", i, 1000 + i, null, "{}");
        db.exec("COMMIT");
        for (const statistics of [false, true]) {
            if (statistics) db.exec("ANALYZE");
            for (const count of [1, 3, 500]) {
                const plan = db
                    .prepare(`EXPLAIN QUERY PLAN ${messageTimesQuery(count)}`)
                    .all("long", ...Array.from({ length: count }, (_, i) => `m${i}`)) as Array<{
                    detail: string;
                }>;
                const detail = plan.map((row) => row.detail).join(" | ");
                console.log(`OC2_TIMES_PLAN statistics=${statistics} ids=${count}: ${detail}`);
                expect(detail).toMatch(
                    /USING (INDEX sqlite_autoindex_session_message_1|PRIMARY KEY) \(id=\?\)/,
                );
                expect(detail).not.toContain("session_message_session_");
                expect(detail).not.toMatch(/\bSCAN\b/);
            }
        }
    } finally {
        db.close();
    }
});

/** Count the message ids the hook asks the store for times of. */
function countTimeReads() {
    const reads: string[][] = [];
    const real = V2StoreReader.prototype.messageTimes;
    const spy = spyOn(V2StoreReader.prototype, "messageTimes").mockImplementation(function (
        this: V2StoreReader,
        sessionID: string,
        ids: readonly string[],
        versions?: Parameters<V2StoreReader["messageTimes"]>[2],
    ) {
        reads.push([...ids]);
        return real.call(this, sessionID, ids, versions);
    });
    return { reads, restore: () => spy.mockRestore() };
}

test("OC2 temporal passes reuse settled times instead of rereading the draft", async () => {
    const failure = installTransientFailure();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    const f = await oc2ContextFixture(9204, { area: AREA, instructions: false });
    const counted = countTimeReads();
    try {
        await f.pass();
        expect(counted.reads.flat().length).toBeGreaterThan(20);
        counted.reads.length = 0;
        await f.pass();
        expect(counted.reads.flat()).toEqual([]);
        f.respond();
        f.user(`9204 the next turn: ${prose}`, 120000);
        counted.reads.length = 0;
        await f.pass();
        expect(counted.reads.flat()).toHaveLength(2);
    } finally {
        counted.restore();
        failure.restore();
        limit.mockRestore();
        await f.cleanup();
    }
}, 60000);

// Temporal awareness off: a pass reads only the times the saved copy's anchor
// needs (the latest assistant message and the messages after it), not every
// message's. A busy admission rebuilds the replay input on every writer retry;
// those retries and the pass after them read each id once.
test("OC2 replay: a temporal-off pass reads only the anchor's times, once per pass", async () => {
    const failure = installTransientFailure();
    const admission = installBusyAdmission();
    const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
    const f = await oc2ContextFixture(9203, { area: AREA, instructions: false, temporal: false });
    const counted = countTimeReads();
    try {
        f.compartment(4);
        await f.pass();
        f.respond();
        f.user(`9203 the saved turn: ${prose}`, 120000);
        counted.reads.length = 0;
        const healthy = await f.pass();
        // The latest assistant message and the user message after it.
        expect(counted.reads.flat().sort()).toEqual(healthy.inputIds.slice(-2).sort());
        expect(getSlot(f.session)).toBeDefined();
        f.respond();
        f.user(`9203 a busy turn the replay declines: ${prose}`, 120000);
        // A changed host system makes the replay decline, so the busy first
        // attempt is followed by the retry and the whole pass.
        f.setSystem("Review a different project.");
        counted.reads.length = 0;
        admission.state.busyNext = true;
        const busy = await f.attempt();
        expect(busy.error).toBeUndefined();
        const ids = counted.reads.flat();
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.sort()).toEqual(busy.inputIds.slice(-2).sort());
    } finally {
        counted.restore();
        admission.restore();
        failure.restore();
        limit.mockRestore();
        await f.cleanup();
    }
}, 60000);
