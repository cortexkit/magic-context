/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    readRawSessionMessagePageFromDb,
    readRawSessionMessagesFromDb,
    readRawSessionTailFromDb,
} from "./read-session-raw";

const SESSION = "ses-raw-metadata";

/** Workspace diagnostics of roughly `files` × 40 entries, as edit and write tools store them. */
function diagnostics(files: number): Record<string, unknown[]> {
    const result: Record<string, unknown[]> = {};
    for (let file = 0; file < files; file += 1) {
        result[`/repo/src/file-${file}.ts`] = Array.from({ length: 40 }, (_, line) => ({
            range: { start: { line, character: 0 }, end: { line, character: 4 } },
            severity: 1,
            message: "Cannot find name 'x'.",
        }));
    }
    return result;
}

function sessionDb(): Database {
    const db = new Database(":memory:");
    db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    message.run("m1", SESSION, 1, 1, JSON.stringify({ role: "user" }));
    part.run("p0", "m1", SESSION, 1, 1, JSON.stringify({ type: "text", text: "edit it" }));
    message.run("m2", SESSION, 2, 2, JSON.stringify({ role: "assistant" }));
    const parts = {
        big: {
            type: "tool",
            tool: "edit",
            callID: "call-big",
            state: {
                status: "completed",
                input: { filePath: "/repo/a.ts" },
                output: "Edit applied successfully.",
                metadata: {
                    diagnostics: diagnostics(20),
                    description: "Edit a.ts",
                    title: "a.ts",
                    answers: [["yes"]],
                },
            },
        },
        small: {
            type: "tool",
            tool: "bash",
            callID: "call-small",
            state: {
                status: "completed",
                input: { command: "ls" },
                output: "a.ts",
                metadata: { output: "a.ts", exit: 0 },
            },
        },
        error: {
            type: "tool",
            tool: "bash",
            callID: "call-error",
            state: {
                status: "error",
                input: { command: "sleep 100" },
                error: "aborted",
                metadata: { interrupted: true, output: "partial", diagnostics: diagnostics(20) },
            },
        },
    };
    let index = 1;
    for (const value of Object.values(parts)) {
        part.run(`p${index}`, "m2", SESSION, 2, 2, JSON.stringify(value));
        index += 1;
    }
    return db;
}

function toolStates(messages: Array<{ parts: unknown[] }>): Record<string, unknown> {
    const states: Record<string, unknown> = {};
    for (const message of messages) {
        for (const part of message.parts as Array<Record<string, unknown>>) {
            if (part.type === "tool") states[part.callID as string] = part.state;
        }
    }
    return states;
}

describe("raw session readers and large tool metadata", () => {
    it("load large completed-tool metadata as only the keys readers use, and everything else whole", () => {
        const db = sessionDb();
        try {
            const readers = {
                full: readRawSessionMessagesFromDb(db, SESSION),
                page: readRawSessionMessagePageFromDb(db, SESSION, 0, 10),
                tail: readRawSessionTailFromDb(db, SESSION, 1, "m1")?.messages ?? [],
            };
            for (const [reader, messages] of Object.entries(readers)) {
                const states = toolStates(messages) as Record<string, Record<string, unknown>>;
                expect({ reader, metadata: states["call-big"]?.metadata }).toEqual({
                    reader,
                    metadata: { description: "Edit a.ts", title: "a.ts", answers: [["yes"]] },
                });
                expect(states["call-big"]?.input).toEqual({ filePath: "/repo/a.ts" });
                expect(states["call-big"]?.output).toBe("Edit applied successfully.");
                expect(states["call-small"]?.metadata).toEqual({ output: "a.ts", exit: 0 });
                const errorMetadata = states["call-error"]?.metadata as Record<string, unknown>;
                expect(errorMetadata.interrupted).toBe(true);
                expect(Object.keys(errorMetadata.diagnostics as object)).toHaveLength(20);
            }
        } finally {
            closeQuietly(db);
        }
    });
});
