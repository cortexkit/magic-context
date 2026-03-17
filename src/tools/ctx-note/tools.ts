import type { Database } from "bun:sqlite";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import {
    addSessionNote,
    clearSessionNotes,
    getSessionNotes,
    type SessionNote,
} from "../../features/magic-context/storage";
import { CTX_NOTE_DESCRIPTION } from "./constants";
import type { CtxNoteArgs } from "./types";

export interface CtxNoteToolDeps {
    db: Database;
}

function createCtxNoteTool(deps: CtxNoteToolDeps): ToolDefinition {
    return tool({
        description: CTX_NOTE_DESCRIPTION,
        args: {
            action: tool.schema
                .enum(["write", "read", "clear"])
                .optional()
                .describe(
                    "Operation to perform. Defaults to 'write' when content is provided, otherwise 'read'.",
                ),
            content: tool.schema
                .string()
                .optional()
                .describe("Note text to store when action is 'write'."),
        },
        async execute(args: CtxNoteArgs, toolContext) {
            const sessionId = toolContext.sessionID;
            const action = args.action ?? (typeof args.content === "string" ? "write" : "read");

            if (action === "write") {
                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'write'.";
                }

                addSessionNote(deps.db, sessionId, content);
                const total = getSessionNotes(deps.db, sessionId).length;
                return `Saved session note ${total}. Historian will rewrite or deduplicate notes as needed.`;
            }

            if (action === "clear") {
                const existing = getSessionNotes(deps.db, sessionId);
                clearSessionNotes(deps.db, sessionId);
                return existing.length === 0
                    ? "Session notes were already empty."
                    : `Cleared ${existing.length} session note${existing.length === 1 ? "" : "s"}.`;
            }

            const notes = getSessionNotes(deps.db, sessionId);
            if (notes.length === 0) {
                return "## Session Notes\n\nNo session notes saved yet.";
            }

            const lines = notes.map(
                (note: SessionNote, index: number) => `${index + 1}. ${note.content}`,
            );
            return `## Session Notes\n\n${lines.join("\n")}`;
        },
    });
}

export function createCtxNoteTools(deps: CtxNoteToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_note: createCtxNoteTool(deps),
    };
}
