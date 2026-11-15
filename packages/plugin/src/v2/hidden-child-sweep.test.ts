import { expect, test } from "bun:test";
import { Database } from "../shared/sqlite";
import {
    createHiddenChildSweeper,
    extendHiddenChildDeadline,
    HIDDEN_CHILD_DEADLINE_GRACE_MS,
    HIDDEN_CHILD_MAX_AGE_MS,
    recordHiddenChild,
    sweepHiddenChildren,
} from "./hidden-child-sweep";

function fixture() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const now = 10 * HIDDEN_CHILD_MAX_AGE_MS;
    const add = (id: string, age: number, deadline_at?: number) =>
        recordHiddenChild(db, {
            id,
            directory: "/project",
            created_at: now - age,
            ...(deadline_at === undefined ? {} : { deadline_at }),
        });
    const ids = () =>
        (
            db.prepare("SELECT key FROM schema_migrations_meta ORDER BY key").all() as Array<{
                key: string;
            }>
        ).map((row) => row.key);
    return { db, now, add, ids };
}

test("the sweep removes only children older than one hour, not another instance's younger run", async () => {
    const state = fixture();
    try {
        state.add("old", HIDDEN_CHILD_MAX_AGE_MS + 1);
        state.add("boundary", HIDDEN_CHILD_MAX_AGE_MS);
        state.add("young", HIDDEN_CHILD_MAX_AGE_MS - 1);
        const removed: string[] = [];
        await sweepHiddenChildren(
            state.db,
            async ({ sessionID }) => {
                removed.push(sessionID);
            },
            () => {},
            { now: state.now },
        );
        expect(removed).toEqual(["old"]);
        expect(state.ids()).toEqual(["hidden_child:boundary", "hidden_child:young"]);
    } finally {
        state.db.close();
    }
});

test("the sweep waits for the later of one hour and the configured deadline plus ten minutes", async () => {
    const state = fixture();
    try {
        const grace = HIDDEN_CHILD_DEADLINE_GRACE_MS;
        const old = 2 * HIDDEN_CHILD_MAX_AGE_MS;
        state.add("running", old, state.now + HIDDEN_CHILD_MAX_AGE_MS);
        state.add("grace", old, state.now - grace + 1);
        state.add("boundary", old, state.now - grace);
        state.add("expired", old, state.now - grace - 1);
        state.add("young", HIDDEN_CHILD_MAX_AGE_MS - 1, state.now - old);
        const removed: string[] = [];
        await sweepHiddenChildren(
            state.db,
            async ({ sessionID }) => {
                removed.push(sessionID);
            },
            () => {},
            { now: state.now },
        );
        expect(removed).toEqual(["expired"]);
        expect(state.ids()).toEqual([
            "hidden_child:boundary",
            "hidden_child:grace",
            "hidden_child:running",
            "hidden_child:young",
        ]);
    } finally {
        state.db.close();
    }
});

test("extending a hidden-child deadline never moves it earlier", () => {
    const state = fixture();
    try {
        state.add("retry", HIDDEN_CHILD_MAX_AGE_MS + 1, state.now);
        extendHiddenChildDeadline(state.db, "retry", state.now + 1000);
        extendHiddenChildDeadline(state.db, "retry", state.now - 1000);
        const row = state.db.prepare("SELECT value FROM schema_migrations_meta").get() as {
            value: string;
        };
        expect(JSON.parse(row.value).deadline_at).toBe(state.now + 1000);
    } finally {
        state.db.close();
    }
});

test("a sweep pass stops at fifty removals and the next pass continues", async () => {
    const state = fixture();
    try {
        for (let index = 0; index < 53; index++)
            state.add(`old-${index}`, HIDDEN_CHILD_MAX_AGE_MS + 1);
        const removed: string[] = [];
        const remove = async ({ sessionID }: { sessionID: string }) => {
            removed.push(sessionID);
        };
        await sweepHiddenChildren(state.db, remove, () => {}, { now: state.now });
        expect(removed).toHaveLength(50);
        expect(state.ids()).toHaveLength(3);
        await sweepHiddenChildren(state.db, remove, () => {}, { now: state.now });
        expect(new Set(removed).size).toBe(53);
        expect(state.ids()).toEqual([]);
    } finally {
        state.db.close();
    }
});

test("a sweep pass stops after thirty seconds and the next pass continues", async () => {
    const state = fixture();
    try {
        state.add("first", HIDDEN_CHILD_MAX_AGE_MS + 1);
        state.add("second", HIDDEN_CHILD_MAX_AGE_MS + 1);
        let elapsed = 0;
        const removed: string[] = [];
        const remove = async ({ sessionID }: { sessionID: string }) => {
            removed.push(sessionID);
            elapsed += 30_000;
        };
        await sweepHiddenChildren(state.db, remove, () => {}, {
            now: state.now,
            clock: () => elapsed,
        });
        expect(removed).toEqual(["first"]);
        expect(state.ids()).toEqual(["hidden_child:second"]);
        await sweepHiddenChildren(state.db, remove, () => {}, {
            now: state.now,
            clock: () => elapsed,
        });
        expect(removed).toEqual(["first", "second"]);
        expect(state.ids()).toEqual([]);
    } finally {
        state.db.close();
    }
});

test("sweep startup returns immediately and disposal waits only for the removal in flight", async () => {
    const state = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const removed: string[] = [];
    const sweeper = createHiddenChildSweeper(
        async ({ sessionID }) => {
            removed.push(sessionID);
            await held;
        },
        () => {},
        { now: state.now },
    );
    try {
        state.add("first", HIDDEN_CHILD_MAX_AGE_MS + 1);
        state.add("second", HIDDEN_CHILD_MAX_AGE_MS + 1);
        expect(sweeper.start(state.db)).toBeUndefined();
        expect(removed).toEqual(["first"]);
        // Overlapping timer ticks must not dispatch the same removal twice.
        sweeper.start(state.db);
        let disposed = false;
        const disposing = sweeper.dispose().then(() => {
            disposed = true;
        });
        await Promise.resolve();
        expect(disposed).toBe(false);
        release();
        await disposing;
        expect(removed).toEqual(["first"]);
        expect(state.ids()).toEqual(["hidden_child:second"]);
        sweeper.start(state.db);
        expect(removed).toEqual(["first"]);
    } finally {
        release();
        await sweeper.dispose();
        state.db.close();
    }
});

test("the sweep clears not-found records but keeps failed removals for its next pass", async () => {
    const state = fixture();
    try {
        state.add("missing", HIDDEN_CHILD_MAX_AGE_MS + 1);
        state.add("failed", HIDDEN_CHILD_MAX_AGE_MS + 1);
        await sweepHiddenChildren(
            state.db,
            async ({ sessionID }) => {
                throw sessionID === "missing" ? { status: 404 } : new Error("host unavailable");
            },
            () => {},
            { now: state.now },
        );
        expect(state.ids()).toEqual(["hidden_child:failed"]);
        await sweepHiddenChildren(
            state.db,
            async () => {},
            () => {},
            { now: state.now },
        );
        expect(state.ids()).toEqual([]);
    } finally {
        state.db.close();
    }
});

test("the sweep bounds stuck removals and retains their records", async () => {
    const state = fixture();
    try {
        state.add("stuck", HIDDEN_CHILD_MAX_AGE_MS + 1);
        const notes: string[] = [];
        await sweepHiddenChildren(
            state.db,
            async () => {
                await new Promise(() => {});
            },
            (line) => notes.push(line),
            { now: state.now, removalTimeoutMs: 5 },
        );
        expect(state.ids()).toEqual(["hidden_child:stuck"]);
        expect(notes[0]).toContain("session.remove timed out");
    } finally {
        state.db.close();
    }
});
