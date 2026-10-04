import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import type { McpTool } from "./mcp/server";
import { openRuntime, type Runtime } from "./runtime";
import type { ClaudeCodeSession } from "./session";
import {
    assistantRecord,
    compactBoundaryRecord,
    compactSummaryRecord,
    textBlock,
    toolResultRecord,
    toolUseBlock,
    userRecord,
    writeTranscript,
} from "./test-fixtures";
import { CLAUDE_CODE_TOOL_NAMES, createClaudeCodeTools } from "./tools";
import { claudeConfigDir } from "./transcript";

let runtime: Runtime;
let project: string;
let sessionCounter = 0;

beforeAll(() => {
    const { dir } = createTestTempDir("mc-claude-code-tools-");
    project = join(dir, "project");
    mkdirSync(project);
    runtime = openRuntime(project);
});

afterAll(() => runtime.close());

function newSession(): ClaudeCodeSession {
    sessionCounter++;
    return { sessionId: `tools-session-${sessionCounter}`, directory: project, source: "env" };
}

function toolsFor(session: ClaudeCodeSession): Map<string, McpTool> {
    return new Map(createClaudeCodeTools({ runtime, session }).map((tool) => [tool.name, tool]));
}

function properties(tool: McpTool | undefined): string[] {
    return Object.keys((tool?.inputSchema.properties ?? {}) as object);
}

describe("tool definitions", () => {
    test("offers the four Claude Code tools with object schemas", () => {
        const tools = toolsFor(newSession());
        expect([...tools.keys()].sort()).toEqual([...CLAUDE_CODE_TOOL_NAMES].sort());
        for (const tool of tools.values()) {
            expect(tool.inputSchema.type).toBe("object");
            expect(tool.description.length).toBeGreaterThan(50);
        }
        expect(tools.has("ctx_reduce")).toBe(false);
    });

    test("hides parameters that only a fully managed host can honor", () => {
        const tools = toolsFor(newSession());
        expect(properties(tools.get("ctx_expand"))).not.toContain("tag");
        expect(properties(tools.get("ctx_expand"))).toContain("message");
        expect(properties(tools.get("ctx_note"))).not.toContain("surface_condition");
        expect(properties(tools.get("ctx_search"))).toContain("query");
    });

    test("descriptions do not mention machinery Claude Code does not have", () => {
        const tools = toolsFor(newSession());
        for (const name of ["ctx_search", "ctx_expand", "ctx_note"]) {
            const description = tools.get(name)?.description ?? "";
            expect(description).not.toContain("ctx_reduce");
            expect(description).not.toContain("<session-history>");
            expect(description).not.toContain("§");
        }
    });

    test("marks lookups read-only and writes not", () => {
        const tools = toolsFor(newSession());
        expect(tools.get("ctx_search")?.annotations?.readOnlyHint).toBe(true);
        expect(tools.get("ctx_expand")?.annotations?.readOnlyHint).toBe(true);
        expect(tools.get("ctx_memory")?.annotations?.readOnlyHint).toBe(false);
        expect(tools.get("ctx_note")?.annotations?.readOnlyHint).toBe(false);
    });
});

describe("tool calls", () => {
    test("rejects arguments that do not match the schema", async () => {
        const result = await toolsFor(newSession())
            .get("ctx_memory")
            ?.call({ action: "obliterate" });
        expect(result?.isError).toBe(true);
        expect(result?.text).toStartWith("Invalid arguments: action");
    });

    test("writes a memory and finds it again from another session", async () => {
        const write = await toolsFor(newSession()).get("ctx_memory")?.call({
            action: "write",
            category: "CONSTRAINTS",
            content: "The billing service rejects requests without an Idempotency-Key header.",
        });
        expect(write?.isError).toBe(false);
        expect(write?.text).toMatch(/Saved memory \[ID: \d+\]/);

        const search = await toolsFor(newSession())
            .get("ctx_search")
            ?.call({ query: "what header does the billing service require?" });
        expect(search?.isError).toBe(false);
        expect(search?.text).toContain("Idempotency-Key");
        expect(search?.text).toContain("[memory]");
    });

    test("notes belong to the session that wrote them", async () => {
        const session = newSession();
        const tools = toolsFor(session);
        const write = await tools.get("ctx_note")?.call({
            action: "write",
            content: "Revisit the flaky upload test\nIt fails when the CDN is slow.",
        });
        expect(write?.text).toContain("Saved session note");
        const read = await tools.get("ctx_note")?.call({ action: "read" });
        expect(read?.text).toContain("Revisit the flaky upload test");

        const otherRead = await toolsFor(newSession()).get("ctx_note")?.call({ action: "read" });
        expect(otherRead?.text).not.toContain("Revisit the flaky upload test");
    });

    test("searches and expands only what Claude Code compacted away", async () => {
        const session = newSession();
        writeTranscript(claudeConfigDir(), project, session.sessionId, [
            userRecord("The staging cluster lives in region eu-north-7 and is called heron."),
            assistantRecord("msg_a", [
                textBlock("Noted, checking the deploy script."),
                toolUseBlock("toolu_1", "Read", { file_path: "scripts/deploy.sh" }),
            ]),
            toolResultRecord("toolu_1", "#!/bin/sh\nkubectl --context heron apply -f k8s/"),
            assistantRecord("msg_b", [textBlock("The script deploys to heron.")]),
            compactBoundaryRecord(),
            compactSummaryRecord("Summary: discussed the staging cluster."),
            userRecord("Live question about the pelican cluster in region us-south-9."),
        ]);
        const tools = toolsFor(session);

        const hit = await tools.get("ctx_search")?.call({
            query: "which region is the staging cluster heron in?",
            sources: ["message"],
        });
        expect(hit?.isError).toBe(false);
        expect(hit?.text).toContain("eu-north-7");
        expect(hit?.text).toContain("ordinal=1");

        // The live tail is already visible to the model and is never returned.
        const live = await tools
            .get("ctx_search")
            ?.call({ query: "pelican cluster us-south-9", sources: ["message"] });
        expect(live?.text).not.toContain("[message]");

        const expanded = await tools.get("ctx_expand")?.call({ message: 2 });
        expect(expanded?.isError).toBe(false);
        expect(expanded?.text).toContain("kubectl --context heron");

        const range = await tools.get("ctx_expand")?.call({ start: 1, end: 3 });
        expect(range?.text).toContain("eu-north-7");
        expect(range?.text).toContain("The script deploys to heron.");
    });

    test("a session that was never compacted has no message hits", async () => {
        const session = newSession();
        writeTranscript(claudeConfigDir(), project, session.sessionId, [
            userRecord("Everything here is about the osprey migration."),
        ]);
        const result = await toolsFor(session)
            .get("ctx_search")
            ?.call({ query: "osprey migration", sources: ["message"] });
        expect(result?.text).not.toContain("[message]");
    });

    test("follows the process into the session /clear or /resume switched to", async () => {
        const started = newSession();
        const afterClear = newSession();
        let current = started;
        const tools = createClaudeCodeTools({
            runtime,
            session: started,
            currentSession: () => current,
        });
        const note = tools.find((tool) => tool.name === "ctx_note");
        await note?.call({ action: "write", content: "Written before the clear" });
        current = afterClear;
        await note?.call({ action: "write", content: "Written after the clear" });

        const before = await toolsFor(started).get("ctx_note")?.call({ action: "read" });
        const after = await toolsFor(afterClear).get("ctx_note")?.call({ action: "read" });
        expect(before?.text).toContain("Written before the clear");
        expect(before?.text).not.toContain("Written after the clear");
        expect(after?.text).toContain("Written after the clear");
        expect(after?.text).not.toContain("Written before the clear");
    });

    test("a project with Magic Context disabled gets a refusal, not a write", async () => {
        const disabled = { ...runtime, config: { ...runtime.config, enabled: false } };
        const memory = createClaudeCodeTools({ runtime: disabled, session: newSession() }).find(
            (tool) => tool.name === "ctx_memory",
        );
        const result = await memory?.call({
            action: "write",
            category: "NAMING",
            content: "This must not be saved.",
        });
        expect(result?.isError).toBe(true);
        expect(result?.text).toContain("disabled for this project");
    });

    test("without storage every call explains why", async () => {
        const tools = createClaudeCodeTools({
            runtime: null,
            session: newSession(),
            unavailableReason: "Magic Context storage is unavailable: disk full",
        });
        expect(tools.map((tool) => tool.name).sort()).toEqual([...CLAUDE_CODE_TOOL_NAMES].sort());
        const result = await tools[0].call({});
        expect(result).toEqual({
            text: "Magic Context storage is unavailable: disk full",
            isError: true,
        });
    });
});
