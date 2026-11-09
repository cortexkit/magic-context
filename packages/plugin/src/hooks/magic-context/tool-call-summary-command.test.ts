/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { rawMessages } from "../../v2/hooks/store";
import type { StoreRow } from "../../v2/store-reader";
import { readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import { extractToolCallSummaries } from "./read-session-formatting";
import { readRawSessionMessageSummaryPageFromDb } from "./read-session-raw";

// The summarizer reads a tool call only through its `TC:` line; it never sees the
// output. A shell call without a description used to render as a bare
// `TC: shell`, so a summary could not say what the agent had run.

const toolPart = (tool: string, input: Record<string, unknown>) => ({
    type: "tool",
    tool,
    callID: `call-${tool}`,
    state: { status: "completed", input, output: "ok" },
});

describe("tool-call summary lines for shell calls", () => {
    it("keep the command when the call has no description", () => {
        expect(
            extractToolCallSummaries([toolPart("shell", { command: "cat PLAYBOOK.md" })]),
        ).toEqual(["TC: shell(cat PLAYBOOK.md)"]);
        expect(
            extractToolCallSummaries([toolPart("bash", { command: "git status --short" })]),
        ).toEqual(["TC: bash(git status --short)"]);
    });

    it("keep the description first when the call has one", () => {
        expect(
            extractToolCallSummaries([
                toolPart("shell", { command: "cat PLAYBOOK.md", description: "Read the playbook" }),
            ]),
        ).toEqual(["TC: Read the playbook"]);
    });

    it("put a multi-line command on one line and cut it at 200 characters", () => {
        const command = `cd /home/agent/work/bridge && sed -n '1,80p' PLAYBOOK.md\n  | grep -n rule && ${"x".repeat(300)}`;
        const [line] = extractToolCallSummaries([toolPart("shell", { command })]);
        const argument = line?.slice("TC: shell(".length, -")".length) ?? "";
        expect(argument).toStartWith(
            "cd /home/agent/work/bridge && sed -n '1,80p' PLAYBOOK.md | grep -n rule && x",
        );
        expect(argument).not.toContain("\n");
        expect(argument).toHaveLength(201);
        expect(argument).toEndWith("…");
        expect(extractToolCallSummaries([toolPart("shell", { command: " \n " })])).toEqual([
            "TC: shell",
        ]);
    });

    it("reach the historian chunk from an OpenCode 2 store row", () => {
        const rows = [
            {
                id: "row-1",
                session_id: "s",
                type: "user",
                seq: 1,
                data: { text: "check the case" },
            },
            {
                id: "row-2",
                session_id: "s",
                type: "assistant",
                seq: 2,
                data: {
                    model: { providerID: "p", id: "m" },
                    content: [
                        {
                            type: "tool",
                            id: "call-1",
                            name: "shell",
                            state: {
                                status: "completed",
                                input: { command: "cat PLAYBOOK.md" },
                                content: [{ type: "text", text: "rule 1" }],
                            },
                        },
                    ],
                },
            },
        ] as unknown as StoreRow[];
        const messages = rawMessages(rows);
        const chunk = withRawMessageProvider(
            "ses-oc2-shell",
            { readMessages: () => messages },
            () => readSessionChunk("ses-oc2-shell", 10_000, 1),
        );
        expect(chunk.text).toContain("[2] A: TC: shell(cat PLAYBOOK.md)");
    });

    it("keep the command in the OpenCode 1 summary page projection", () => {
        const db = new Database(":memory:");
        try {
            db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
                "m1",
                "ses-oc1-shell",
                1,
                1,
                JSON.stringify({ role: "assistant" }),
            );
            db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
                "p1",
                "m1",
                "ses-oc1-shell",
                1,
                1,
                JSON.stringify(toolPart("bash", { command: "git status --short" })),
            );
            const [message] = readRawSessionMessageSummaryPageFromDb(db, "ses-oc1-shell", 0, 10);
            expect(extractToolCallSummaries(message?.parts ?? [])).toEqual([
                "TC: bash(git status --short)",
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
