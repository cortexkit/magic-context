import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
    assistantRecord,
    compactBoundaryRecord,
    compactSummaryRecord,
    textBlock,
    toJsonl,
    toolResultRecord,
    toolUseBlock,
    userRecord,
    writeTranscript,
} from "./test-fixtures";
import {
    __resetTranscriptCacheForTests,
    claudeConfigDir,
    createTranscriptSource,
    encodeProjectDirectory,
    locateTranscript,
    parseClaudeCodeTranscript,
} from "./transcript";

type Part = { type: string; text?: string; tool?: string; callID?: string; state?: any };

function partsOf(message: { parts: unknown[] }): Part[] {
    return message.parts as Part[];
}

afterEach(() => __resetTranscriptCacheForTests());

describe("parseClaudeCodeTranscript", () => {
    test("reads user and assistant text in order with 1-based ordinals", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                userRecord("first question"),
                assistantRecord("msg_1", [textBlock("first answer")]),
                userRecord([{ type: "text", text: "second question" }]),
            ]),
        );
        expect(parsed.messages.map((message) => [message.ordinal, message.role])).toEqual([
            [1, "user"],
            [2, "assistant"],
            [3, "user"],
        ]);
        expect(partsOf(parsed.messages[2])[0].text).toBe("second question");
        expect(parsed.messages[0].createdAt).toBeGreaterThan(0);
        expect(parsed.compactedThroughOrdinal).toBe(0);
        expect(parsed.skippedLines).toBe(0);
    });

    test("merges streamed records of one API message and pairs tool results onto the call", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                userRecord("read the config"),
                assistantRecord("msg_1", [{ type: "thinking", thinking: "hmm" }]),
                assistantRecord("msg_1", [textBlock("Reading it now.")]),
                assistantRecord("msg_1", [
                    toolUseBlock("toolu_1", "Read", { file_path: "/repo/config.json" }),
                ]),
                toolResultRecord("toolu_1", '{"port": 8080}'),
                assistantRecord("msg_2", [toolUseBlock("toolu_2", "Bash", { command: "false" })]),
                toolResultRecord("toolu_2", "exit 1", true),
                assistantRecord("msg_3", [textBlock("Port is 8080.")]),
            ]),
        );
        expect(parsed.messages).toHaveLength(4);
        const [, firstReply, secondReply, last] = parsed.messages;
        expect(partsOf(firstReply).map((part) => part.type)).toEqual(["text", "tool"]);
        const read = partsOf(firstReply)[1];
        expect(read.tool).toBe("Read");
        expect(read.callID).toBe("toolu_1");
        expect(read.state.status).toBe("completed");
        expect(read.state.output).toBe('{"port": 8080}');
        // The shared formatter's tool summaries look for camelCase `filePath`.
        expect(read.state.input.filePath).toBe("/repo/config.json");
        expect(read.state.input.file_path).toBe("/repo/config.json");

        const bash = partsOf(secondReply)[0];
        expect(bash.state.status).toBe("error");
        expect(bash.state.error).toBe("exit 1");
        expect(partsOf(last)[0].text).toBe("Port is 8080.");
    });

    test("a tool call still waiting for its result is pending", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                assistantRecord("msg_1", [toolUseBlock("toolu_9", "Bash", { command: "ls" })]),
            ]),
        );
        expect(partsOf(parsed.messages[0])[0].state.status).toBe("pending");
    });

    test("keeps a tool result whose call is not in the file as its own user message", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([toolResultRecord("toolu_gone", "orphan output")]),
        );
        expect(parsed.messages).toHaveLength(1);
        const part = partsOf(parsed.messages[0])[0];
        expect(part.type).toBe("tool");
        expect(part.state.output).toBe("orphan output");
    });

    test("skips sidechain, meta, compact-summary and transcript-only records", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                userRecord("real prompt"),
                userRecord("subagent prompt", { isSidechain: true }),
                assistantRecord("msg_side", [textBlock("subagent reply")], { isSidechain: true }),
                userRecord("<local-command-caveat>caveat</local-command-caveat>", { isMeta: true }),
                userRecord("only in the transcript UI", { isVisibleInTranscriptOnly: true }),
                { type: "attachment", uuid: "a-1" },
                { type: "system", subtype: "informational", content: "note" },
                assistantRecord("msg_1", [textBlock("real reply")]),
            ]),
        );
        expect(parsed.messages.map((message) => partsOf(message)[0].text)).toEqual([
            "real prompt",
            "real reply",
        ]);
    });

    test("turns slash-command markup into the command line and drops local output echoes", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                userRecord(
                    "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
                ),
                userRecord("<local-command-stdout>Compacted </local-command-stdout>"),
                userRecord(
                    "<command-message>magic-context:remember</command-message>\n<command-name>/magic-context:remember</command-name>\n<command-args>deploys need a ticket</command-args>",
                ),
                userRecord("I wrote <command-name>x</command-name> in prose"),
            ]),
        );
        expect(parsed.messages.map((message) => partsOf(message)[0].text)).toEqual([
            "/compact",
            "/magic-context:remember deploys need a ticket",
            "I wrote <command-name>x</command-name> in prose",
        ]);
    });

    test("counts the messages a compaction removed and skips its generated summary", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                userRecord("old question"),
                assistantRecord("msg_1", [textBlock("old answer")]),
                compactBoundaryRecord(),
                compactSummaryRecord("Summary: the user asked an old question."),
                userRecord("new question"),
            ]),
        );
        expect(parsed.messages.map((message) => partsOf(message)[0].text)).toEqual([
            "old question",
            "old answer",
            "new question",
        ]);
        expect(parsed.compactedThroughOrdinal).toBe(2);
    });

    test("messages Claude Code kept through the compaction are not counted as compacted", () => {
        const keptReply = assistantRecord("msg_2", [textBlock("kept reply")]);
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                userRecord("dropped question"),
                assistantRecord("msg_1", [textBlock("dropped answer")]),
                userRecord("kept question"),
                keptReply,
                compactBoundaryRecord(keptReply.uuid as string),
                compactSummaryRecord("summary"),
            ]),
        );
        expect(parsed.compactedThroughOrdinal).toBe(3);
    });

    test("only the latest compaction decides what is out of context", () => {
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                userRecord("one"),
                compactBoundaryRecord(),
                compactSummaryRecord("summary 1"),
                userRecord("two"),
                assistantRecord("msg_1", [textBlock("three")]),
                compactBoundaryRecord(),
                compactSummaryRecord("summary 2"),
                userRecord("four"),
            ]),
        );
        expect(parsed.compactedThroughOrdinal).toBe(3);
        expect(parsed.messages).toHaveLength(4);
    });

    test("an assistant message replayed after a compaction is not duplicated", () => {
        const replay = [toolUseBlock("toolu_1", "Read", { file_path: "a.ts" })];
        const parsed = parseClaudeCodeTranscript(
            toJsonl([
                assistantRecord("msg_1", [textBlock("looking"), ...replay]),
                toolResultRecord("toolu_1", "contents"),
                compactBoundaryRecord(),
                assistantRecord("msg_1", [textBlock("looking"), ...replay]),
            ]),
        );
        expect(parsed.messages).toHaveLength(1);
        const parts = partsOf(parsed.messages[0]);
        expect(parts.map((part) => part.type)).toEqual(["text", "tool"]);
        expect(parts[1].state.output).toBe("contents");
    });

    test("counts malformed lines without failing", () => {
        const parsed = parseClaudeCodeTranscript(
            `${toJsonl([userRecord("ok")])}not json\n[1,2]\n\n`,
        );
        expect(parsed.messages).toHaveLength(1);
        expect(parsed.skippedLines).toBe(2);
    });

    test("versions change when a message grows so index readers notice", () => {
        const first = parseClaudeCodeTranscript(
            toJsonl([assistantRecord("msg_1", [textBlock("a")])]),
        );
        const grown = parseClaudeCodeTranscript(
            toJsonl([
                assistantRecord("msg_1", [textBlock("a")]),
                assistantRecord("msg_1", [textBlock("b")]),
            ]),
        );
        expect(grown.messages[0].version).not.toBe(first.messages[0].version);
    });
});

describe("transcript files", () => {
    test("encodes a project directory the way Claude Code names it", () => {
        expect(encodeProjectDirectory("/home/me/code/my.app")).toBe("-home-me-code-my-app");
    });

    test("claudeConfigDir honors CLAUDE_CONFIG_DIR", () => {
        expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/claude" })).toBe("/custom/claude");
        expect(claudeConfigDir({})).toMatch(/\.claude$/);
    });

    test("locates by project directory, then by scanning every project", () => {
        const { dir } = createTestTempDir("mc-claude-code-locate-");
        const configDir = join(dir, "claude");
        const path = writeTranscript(configDir, "/work/app", "session-a", [userRecord("hi")]);
        expect(
            locateTranscript({ sessionId: "session-a", directory: "/work/app", configDir }),
        ).toBe(path);
        // A moved project directory still finds the file by name.
        expect(
            locateTranscript({ sessionId: "session-a", directory: "/elsewhere", configDir }),
        ).toBe(path);
        expect(locateTranscript({ sessionId: "missing", configDir })).toBeNull();
        expect(locateTranscript({ sessionId: "../escape", configDir })).toBeNull();
    });

    test("finds a transcript filed under the real path of a symlinked project", () => {
        const { dir } = createTestTempDir("mc-claude-code-symlink-");
        const real = join(dir, "real-project");
        mkdirSync(real);
        const link = join(dir, "linked-project");
        symlinkSync(real, link);
        const configDir = join(dir, "claude");
        const path = writeTranscript(configDir, real, "session-b", [userRecord("hi")]);
        expect(locateTranscript({ sessionId: "session-b", directory: link, configDir })).toBe(path);
    });

    test("an existing transcript_path wins", () => {
        const { dir } = createTestTempDir("mc-claude-code-explicit-");
        const explicit = join(dir, "explicit.jsonl");
        writeFileSync(explicit, toJsonl([userRecord("hi")]));
        expect(
            locateTranscript({
                sessionId: "whatever",
                transcriptPath: explicit,
                configDir: join(dir, "none"),
            }),
        ).toBe(explicit);
    });

    test("a transcript source re-reads the file when it changes", () => {
        const { dir } = createTestTempDir("mc-claude-code-source-");
        const path = join(dir, "s.jsonl");
        writeFileSync(path, toJsonl([userRecord("one")]));
        const source = createTranscriptSource(path);
        expect(source.provider.readMessages()).toHaveLength(1);
        appendFileSync(
            path,
            toJsonl([
                assistantRecord("msg_1", [textBlock("two")]),
                compactBoundaryRecord(),
                userRecord("three"),
            ]),
        );
        expect(source.provider.readMessages()).toHaveLength(3);
        expect(source.compactedThroughOrdinal()).toBe(2);
    });
});
