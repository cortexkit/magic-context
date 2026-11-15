import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { AutoDropConfig } from "./auto-drop";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { type MessageLike, tagMessages } from "./tag-messages";

const session = "auto-drop";
let db: NonNullable<ReturnType<typeof openDatabase>>;
let root: string;
let originalData: string | undefined;
let originalStorage: string | undefined;

beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
    root = createTestTempDirFromPath(join(tmpdir(), "auto-drop-"));
    process.env.XDG_DATA_HOME = root;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
    db = openDatabase()!;
});

afterEach(() => {
    closeDatabase();
    if (originalData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalData;
    if (originalStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorage;
    cleanupTestTempDir(root);
});

const OFF: AutoDropConfig = {
    reread: false,
    retriedErrors: false,
};

function tool(
    callID: string,
    name: string,
    input: object,
    result: { output?: string; error?: string },
) {
    return {
        type: "tool",
        tool: name,
        callID,
        state:
            result.error === undefined
                ? { status: "completed", input, output: result.output ?? "" }
                : // OpenCode 2's store puts a failed call's error text in `output`.
                  { status: "error", input, error: result.error, output: result.error },
    };
}

// One assistant message per call, each after its own user turn.
function turns(...calls: ReturnType<typeof tool>[]): MessageLike[] {
    return calls.flatMap((call, index) => [
        { info: { id: `u${index}`, role: "user" }, parts: [{ type: "text", text: "go" }] },
        { info: { id: `a${index}`, role: "assistant" }, parts: [call] },
    ]);
}

// Returns the status of each tool call, in call order.
function run(messages: MessageLike[], autoDrop: AutoDropConfig): string[] {
    const tagger = createTagger();
    tagger.initFromDb(session, db);
    const tagged = tagMessages(session, messages, tagger, db);
    applyHeuristicCleanup(session, db, tagged.targets, tagged.messageTagNumbers, {
        protectedTagNumbers: new Set(),
        protectedCutoff: null,
        autoDrop,
    });
    tagged.batch.finalize();
    return getTagsBySession(db, session)
        .filter((tag) => tag.type === "tool")
        .sort((left, right) => left.tagNumber - right.tagNumber)
        .map((tag) => tag.status);
}

describe("auto drop", () => {
    it("drops a read once a later read covers the same file", () => {
        const messages = turns(
            tool("c1", "read", { path: "/a.ts", offset: 10, limit: 5 }, { output: "old" }),
            tool("c2", "read", { path: "/b.ts" }, { output: "other" }),
            tool("c3", "read", { path: "/a.ts" }, { output: "new" }),
        );
        expect(run(messages, { ...OFF, reread: true })).toEqual(["dropped", "active", "active"]);
    });

    it("keeps a read when the later read covers a different window", () => {
        const messages = turns(
            tool("c1", "read", { path: "/a.ts", offset: 10, limit: 5 }, { output: "old" }),
            tool("c2", "read", { path: "/a.ts", offset: 40, limit: 5 }, { output: "new" }),
        );
        expect(run(messages, { ...OFF, reread: true })).toEqual(["active", "active"]);
    });

    it("drops a failed call once the same tool later succeeds, but keeps a user rejection", () => {
        const messages = turns(
            tool("c1", "shell", { command: "x" }, { error: "boom" }),
            tool(
                "c2",
                "edit",
                { path: "/a" },
                { error: "The user rejected permission to use this tool" },
            ),
            tool("c3", "shell", { command: "y" }, { output: "ok" }),
            tool("c4", "edit", { path: "/a" }, { output: "ok" }),
        );
        expect(run(messages, { ...OFF, retriedErrors: true })).toEqual([
            "dropped",
            "active",
            "active",
            "active",
        ]);
    });

    it("drops nothing when every rule is off", () => {
        const messages = turns(
            tool("c1", "read", { path: "/a.ts" }, { output: "old" }),
            tool("c2", "read", { path: "/a.ts" }, { output: "new" }),
        );
        expect(run(messages, OFF)).toEqual(["active", "active"]);
    });
});
