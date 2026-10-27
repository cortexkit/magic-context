/// <reference types="bun-types" />
// Regression tests for the tool-definition totals used to size outgoing
// requests: two concurrent requests on one route must not shrink the total
// below what one request carries, rows reloaded after a restart must keep
// counting until the route's tools have all been measured again, and tools
// whose content did not change must not be tokenized or written again when a
// route's tool set alternates. The totals held these properties while they
// summed every tool ever seen on a route; counting only the most recent
// flights of tools loses them, so these tests fail on that version.
//
// They use only exports that both versions of the store have
// (recordToolDefinition, getMeasuredToolDefinitionTokens,
// loadToolDefinitionMeasurements, setDatabase and the reset helper), so the
// same file runs unchanged against either.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    __resetToolDefinitionMeasurements,
    getMeasuredToolDefinitionTokens,
    loadToolDefinitionMeasurements,
    recordToolDefinition,
    setDatabase,
} from "./tool-definition-tokens";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

// One OpenCode 1 `ToolRegistry.tools()` call fires `tool.definition` once per
// offered tool. These are the tools every request on the route carries.
const TOOLS = ["read", "edit", "write", "bash", "grep", "glob", "task", "todowrite"];

function fire(
    agent: string,
    id: string,
    sessionId: string,
    description = `${id} tool description `.repeat(40),
) {
    recordToolDefinition("p", "m", agent, id, description, { type: "object", id }, sessionId);
}

function fullSetTotal(): number {
    // Measured on a separate route so the routes under test stay untouched.
    for (const id of TOOLS) fire("reference", id, "reference-session");
    return getMeasuredToolDefinitionTokens("p", "m", "reference") ?? 0;
}

describe("issue 797 cache review witnesses", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("two concurrent OpenCode 1 requests on one route never shrink the total below one request's tools", () => {
        const full = fullSetTotal();
        expect(full).toBeGreaterThan(0);
        // Two subagent sessions on the same model and agent (parallel `task`
        // calls) resolve their tools at the same time. OpenCode 1 runs each
        // call's tool.definition triggers concurrently (Effect.forEach with
        // unbounded concurrency), so the two calls' fires can alternate. Both
        // requests carry every tool.
        for (const id of TOOLS) {
            fire("explore", id, "child-1");
            fire("explore", id, "child-2");
        }
        // Each child's transform now sizes its request. The request carries
        // the full set, so the total must not be lower.
        expect(
            getMeasuredToolDefinitionTokens("p", "m", "explore", "child-1"),
        ).toBeGreaterThanOrEqual(full);
        expect(
            getMeasuredToolDefinitionTokens("p", "m", "explore", "child-2"),
        ).toBeGreaterThanOrEqual(full);
    });

    test("a read during a route's first live flight after a restart still counts the stored set", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            for (const id of TOOLS) fire("build", id, "session-a");
            const stored = getMeasuredToolDefinitionTokens("p", "m", "build") ?? 0;
            expect(stored).toBeGreaterThan(0);
            // Restart: the in-memory store is rebuilt from the table.
            __resetToolDefinitionMeasurements();
            setDatabase(db);
            loadToolDefinitionMeasurements(db);
            expect(getMeasuredToolDefinitionTokens("p", "m", "build")).toBe(stored);
            // The first request after the restart starts firing the same tools.
            // Halfway through that flight another reader on the route (a
            // concurrent session's transform, or the sidebar) sizes a request
            // that carries the same tools.
            for (const id of TOOLS.slice(0, 2)) fire("build", id, "session-a");
            expect(
                getMeasuredToolDefinitionTokens("p", "m", "build", "session-b"),
            ).toBeGreaterThanOrEqual(stored);
        } finally {
            closeQuietly(db);
        }
    });

    test("a route whose tool set flaps does not re-tokenize or rewrite tools whose content did not change", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            // OpenCode 1 attributes tool.definition fires to the last
            // chat.message, which fires once per user message. After a parent
            // session's `task` child sent its chat.message, the parent's next
            // steps fire the parent's (larger) tool set under the child's route,
            // and the child's own steps fire the child's smaller set there too.
            const parentSet = TOOLS;
            const childSet = ["read", "grep", "glob"];
            for (const id of parentSet) fire("explore", id, "child");
            // Mark every stored row, so a later write of an unchanged tool shows.
            db.prepare("UPDATE tool_definition_measurements SET recorded_at = 1").run();
            // Two child steps, then one parent step, all with unchanged content.
            for (const id of childSet) fire("explore", id, "child");
            for (const id of childSet) fire("explore", id, "child");
            for (const id of parentSet) fire("explore", id, "child");
            const rewritten = db
                .prepare(
                    "SELECT tool_id FROM tool_definition_measurements WHERE recorded_at <> 1 ORDER BY tool_id",
                )
                .all() as Array<{ tool_id: string }>;
            expect(rewritten).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });
});
