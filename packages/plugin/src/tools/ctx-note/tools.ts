import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import {
    addNote,
    dismissNote,
    getNotes,
    getReadySmartNotes,
    getSessionNotes,
    type Note,
    setNoteLastReadAt,
    updateNote,
} from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";
import { CTX_NOTE_DESCRIPTION } from "./constants";
import type { CtxNoteArgs, CtxNoteReadFilter } from "./types";

export interface CtxNoteToolDeps {
    db: Database;
    dreamerEnabled?: boolean;
    projectIdentity?: string;
}

function formatNoteLine(note: Note): string {
    const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;

    if (note.type === "session") {
        return `- **#${note.id}**${statusSuffix}: ${note.content}`;
    }

    const conditionText =
        note.status === "ready"
            ? (note.readyReason ?? note.surfaceCondition ?? "Condition satisfied")
            : (note.surfaceCondition ?? "No condition recorded");
    const conditionLabel = note.status === "ready" ? "Condition met" : "Condition";

    return `- **#${note.id}**${statusSuffix}: ${note.content}\n  ${conditionLabel}: ${conditionText}`;
}

const DISMISS_FOOTER = '\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_id=N)';

function buildReadSections(args: {
    db: Database;
    sessionId: string;
    projectIdentity?: string;
    filter?: CtxNoteReadFilter;
}): string[] {
    if (args.filter === undefined) {
        const sessionNotes = getSessionNotes(args.db, args.sessionId);
        const readySmartNotes = args.projectIdentity
            ? getReadySmartNotes(args.db, args.projectIdentity)
            : [];
        const sections: string[] = [];

        if (sessionNotes.length > 0) {
            sections.push(
                `## Session Notes\n\n${sessionNotes.map((note) => formatNoteLine(note)).join("\n")}`,
            );
        }

        if (readySmartNotes.length > 0) {
            sections.push(
                `## 🔔 Ready Smart Notes\n\n${readySmartNotes
                    .map((note) => formatNoteLine(note))
                    .join("\n\n")}`,
            );
        }

        return sections;
    }

    const statusByFilter: Record<
        CtxNoteReadFilter,
        | "active"
        | "pending"
        | "ready"
        | "dismissed"
        | Array<"active" | "pending" | "ready" | "dismissed">
    > = {
        active: "active",
        all: ["active", "pending", "ready", "dismissed"],
        dismissed: "dismissed",
        pending: "pending",
        ready: "ready",
    };

    const sessionNotes = getNotes(args.db, {
        sessionId: args.sessionId,
        type: "session",
        status: statusByFilter[args.filter],
    });
    const smartNotes = args.projectIdentity
        ? getNotes(args.db, {
              projectPath: args.projectIdentity,
              type: "smart",
              status: statusByFilter[args.filter],
          })
        : [];

    const sections: string[] = [];

    if (sessionNotes.length > 0) {
        sections.push(
            `## Session Notes\n\n${sessionNotes.map((note) => formatNoteLine(note)).join("\n")}`,
        );
    }

    if (smartNotes.length > 0) {
        sections.push(
            `## Smart Notes\n\n${smartNotes.map((note) => formatNoteLine(note)).join("\n\n")}`,
        );
    }

    return sections;
}

function createCtxNoteTool(deps: CtxNoteToolDeps): ToolDefinition {
    return tool({
        description: CTX_NOTE_DESCRIPTION,
        args: {
            action: tool.schema
                .enum(["write", "read", "dismiss", "update"])
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
            filter: tool.schema
                .enum(["all", "active", "pending", "ready", "dismissed"])
                .optional()
                .describe(
                    "Optional read filter. Defaults to active session notes + ready smart notes. Use 'all' to inspect every status or 'pending' to inspect unsurfaced smart notes.",
                ),
            note_id: tool.schema
                .number()
                .optional()
                .describe("Note ID (required for 'dismiss' and 'update' actions)."),
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
                    const note = addNote(deps.db, "smart", {
                        content,
                        projectPath: deps.projectIdentity,
                        sessionId,
                        surfaceCondition: args.surface_condition.trim(),
                    });
                    return `Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${args.surface_condition.trim()}`;
                }

                // Simple session note
                const note = addNote(deps.db, "session", { sessionId, content });
                return `Saved session note #${note.id}. Historian will rewrite or deduplicate notes as needed.`;
            }

            if (action === "dismiss") {
                const noteId = args.note_id;
                if (typeof noteId !== "number") {
                    return "Error: 'note_id' is required when action is 'dismiss'.";
                }
                const dismissed = dismissNote(deps.db, noteId);
                return dismissed
                    ? `Note #${noteId} dismissed.`
                    : `Note #${noteId} not found or already dismissed.`;
            }

            if (action === "update") {
                const noteId = args.note_id;
                if (typeof noteId !== "number") {
                    return "Error: 'note_id' is required when action is 'update'.";
                }
                const updates: { content?: string; surfaceCondition?: string } = {};
                if (args.content?.trim()) updates.content = args.content.trim();
                if (args.surface_condition?.trim())
                    updates.surfaceCondition = args.surface_condition.trim();

                if (!updates.content && !updates.surfaceCondition) {
                    return "Error: Provide 'content' and/or 'surface_condition' to update.";
                }
                const updated = updateNote(deps.db, noteId, updates);
                if (!updated) {
                    return `Note #${noteId} not found or has no compatible fields to update.`;
                }
                const parts: string[] = [];
                if (updates.content) parts.push(`Content: ${updates.content}`);
                if (updates.surfaceCondition) parts.push(`Condition: ${updates.surfaceCondition}`);
                return `Updated note #${noteId}:\n${parts.join("\n")}`;
            }

            const sections = buildReadSections({
                db: deps.db,
                filter: args.filter,
                projectIdentity: deps.projectIdentity,
                sessionId,
            });

            // Record read watermark so note-nudger can suppress reminders
            // when the agent has already seen notes in recent context and no
            // new notes have been written since.
            try {
                setNoteLastReadAt(deps.db, sessionId);
            } catch {
                // Best-effort — the watermark is a suppression hint, not correctness.
            }

            if (sections.length === 0) {
                return "## Notes\n\nNo session notes or smart notes.";
            }

            return sections.join("\n\n") + DISMISS_FOOTER;
        },
    });
}

export function createCtxNoteTools(deps: CtxNoteToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_note: createCtxNoteTool(deps),
    };
}
