import { expect, test } from "bun:test";
import { Database } from "../shared/sqlite";
import {
    HIDDEN_CHILD_MAX_AGE_MS,
    recordHiddenChild,
    sweepHiddenChildren,
} from "./hidden-child-sweep";

function fixture() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const now = 10 * HIDDEN_CHILD_MAX_AGE_MS;
    const add = (id: string, age: number) =>
        recordHiddenChild(db, { id, directory: "/project", created_at: now - age });
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
