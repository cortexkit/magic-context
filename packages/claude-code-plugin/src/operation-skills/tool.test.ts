import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import { createCtxSkillTool } from "./tool";

function setup() {
    const { dir } = createTestTempDir("mc-claude-code-ctx-skill-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/NoteForm.tsx"), "export function NoteForm() {}\n");
    return { dir, tool: createCtxSkillTool({ getProjectDir: () => dir }) };
}

const SAVE_NOTE = {
    id: "save-note",
    trigger: {
        kind: "button",
        label: "保存备注",
        location: "src/NoteForm.tsx:12",
        event: "onClick",
    },
    intents: ["保存备注", "save a note"],
    action: { summary: "POSTs the note text and appends it to notes.json" },
    apis: [{ method: "POST", endpoint: "/api/notes", request: "{ text }" }],
    writes: [{ target: "data/notes.json", fields: "text, createdAt" }],
    state: [{ target: "notes signal", change: "append the saved note" }],
    save_and_linkage: "the note list re-renders",
    files_to_modify: ["src/NoteForm.tsx"],
    steps: [
        "curl -X POST localhost:4000/api/notes -H 'content-type: application/json' -d '{\"text\":\"<text>\"}'",
    ],
    verification: { method: "POST then read data/notes.json", evidence: "note present" },
};

test("ctx_skill saves, finds, reads, verifies and removes an operation", async () => {
    const { dir, tool } = setup();
    expect((await tool.call({ action: "list" })).text).toContain("No operation skills");

    const saved = await tool.call({
        action: "save",
        name: "notes",
        title: "备注",
        description: "Saving notes from the note form.",
        scope: "src",
        operations: [SAVE_NOTE],
    });
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain('Created operation skill "notes" with 1 operation(s)');
    expect(saved.text).toContain("1 file(s) tracked");

    const found = await tool.call({ action: "find", query: "帮我保存一条备注：明天开会" });
    expect(found.text).toContain('Best match: skill "notes"');
    expect(found.text).toContain("`POST /api/notes`");
    expect(found.text).toContain("data/notes.json: text, createdAt");
    expect(found.text).not.toContain("Changed since verification");

    writeFileSync(join(dir, "src/NoteForm.tsx"), "export function NoteForm() { /* changed */ }\n");
    const read = await tool.call({ action: "read", name: "notes", operation: "save-note" });
    expect(read.text).toContain("Changed since verification:** `src/NoteForm.tsx`");

    const verified = await tool.call({
        action: "verify",
        name: "notes",
        operation: "save-note",
        verification: { method: "re-ran the POST" },
    });
    expect(verified.isError).toBe(false);
    expect((await tool.call({ action: "list" })).text).not.toContain("files changed since");

    const removed = await tool.call({ action: "remove", name: "notes" });
    expect(removed.text).toBe('Removed operation skill "notes".');
});

test("ctx_skill explains bad calls instead of failing", async () => {
    const { tool } = setup();
    expect((await tool.call({ action: "explode" })).text).toStartWith("Invalid arguments: action");
    expect((await tool.call({ action: "find" })).text).toBe("Error: find needs a query");
    expect((await tool.call({ action: "read", name: "nope" })).text).toContain(
        'no operation skill named "nope"',
    );
    const unverified = await tool.call({
        action: "save",
        name: "notes",
        title: "t",
        description: "d",
        operations: [{ ...SAVE_NOTE, verification: { method: "" } }],
    });
    expect(unverified.isError).toBe(true);
    expect(unverified.text).toContain("verification.method");
});

test("ctx_skill answers with the reason when Magic Context is off", async () => {
    const { dir } = createTestTempDir("mc-claude-code-ctx-skill-off-");
    const tool = createCtxSkillTool({
        getProjectDir: () => dir,
        unavailable: () => "disabled here",
    });
    expect(await tool.call({ action: "list" })).toEqual({ text: "disabled here", isError: true });
});
