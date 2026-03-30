import type { Database } from "bun:sqlite";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";

import {
    addSessionNote,
    addSmartNote,
    clearSessionNotes,
    dismissSmartNote,
    getReadySmartNotes,
    getSessionNotes,
    type SessionNote,
} from "../../features/magic-context/storage";
import { CTX_NOTE_DESCRIPTION } from "./constants";
import type { CtxNoteArgs } from "./types";

export interface CtxNoteToolDeps {
    db: Database;
    dreamerEnabled?: boolean;
    projectIdentity?: string;
}

function createCtxNoteTool(deps: CtxNoteToolDeps): ToolDefinition {
    return tool({
        description: CTX_NOTE_DESCRIPTION,
        args: {
            action: tool.schema
                .enum(["write", "read", "clear", "dismiss"])
                .optional()
                .describe(
                    "Operation to perform. Defaults to 'write' when content is provided, otherwise 'read'.",
                ),
            content: tool.schema
                .string()
                .optional()
                .describe("Note text to store when action is 'write'."),
            surface_condition: tool.schema
                .string()
                .optional()
                .describe(
                    "Open-ended condition for smart notes. When provided, creates a project-scoped smart note that the dreamer evaluates nightly. The note surfaces when the condition is met.",
                ),
            note_id: tool.schema
                .number()
                .optional()
                .describe("Smart note ID to dismiss (required for 'dismiss' action)."),
        },
        async execute(args: CtxNoteArgs, toolContext) {
            const sessionId = toolContext.sessionID;
            const action = args.action ?? (typeof args.content === "string" ? "write" : "read");

            if (action === "write") {
                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'write'.";
                }

                // Smart note — project-scoped with condition evaluation by dreamer
                if (args.surface_condition?.trim()) {
                    if (!deps.dreamerEnabled) {
                        return "Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.";
                    }
                    if (!deps.projectIdentity) {
                        return "Error: Could not resolve project identity for smart note.";
                    }
                    const note = addSmartNote(
                        deps.db,
                        deps.projectIdentity,
                        content,
                        args.surface_condition.trim(),
                        sessionId,
                    );
                    return `Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${args.surface_condition.trim()}`;
                }

                // Simple session note
                addSessionNote(deps.db, sessionId, content);
                const total = getSessionNotes(deps.db, sessionId).length;
                return `Saved session note ${total}. Historian will rewrite or deduplicate notes as needed.`;
            }

            if (action === "dismiss") {
                const noteId = args.note_id;
                if (typeof noteId !== "number") {
                    return "Error: 'note_id' is required when action is 'dismiss'.";
                }
                const dismissed = dismissSmartNote(deps.db, noteId);
                return dismissed
                    ? `Smart note #${noteId} dismissed.`
                    : `Smart note #${noteId} not found or already dismissed.`;
            }

            if (action === "clear") {
                const existing = getSessionNotes(deps.db, sessionId);
                clearSessionNotes(deps.db, sessionId);
                return existing.length === 0
                    ? "Session notes were already empty."
                    : `Cleared ${existing.length} session note${existing.length === 1 ? "" : "s"}.`;
            }

            // Read — show session notes + ready smart notes only.
            // Pending smart notes are deliberately hidden — they clutter context
            // and the agent can't act on them until dreamer surfaces them.
            const notes = getSessionNotes(deps.db, sessionId);
            const readySmartNotes = deps.projectIdentity
                ? getReadySmartNotes(deps.db, deps.projectIdentity)
                : [];

            const sections: string[] = [];

            if (notes.length > 0) {
                const lines = notes.map(
                    (note: SessionNote, index: number) => `${index + 1}. ${note.content}`,
                );
                sections.push(`## Session Notes\n\n${lines.join("\n")}`);
            }

            if (readySmartNotes.length > 0) {
                const lines = readySmartNotes.map(
                    (n) =>
                        `- **#${n.id}**: ${n.content}\n  Condition met: ${n.readyReason ?? n.surfaceCondition}\n  _(dismiss with \`ctx_note(action="dismiss", note_id=${n.id})\`)_`,
                );
                sections.push(`## 🔔 Ready Smart Notes\n\n${lines.join("\n\n")}`);
            }

            if (sections.length === 0) {
                return "## Notes\n\nNo session notes or smart notes.";
            }

            return sections.join("\n\n");
        },
    });
}

export function createCtxNoteTools(deps: CtxNoteToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_note: createCtxNoteTool(deps),
    };
}
