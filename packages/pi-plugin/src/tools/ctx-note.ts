/**
 * Pi-side wrapper for the `ctx_note` tool.
 *
 * Spike scope (Step 4a): write + read + dismiss + update on simple session
 * notes. Smart notes (with `surface_condition`) require dreamer evaluation,
 * which the pi-plugin doesn't run yet — they're rejected with a clear
 * message instead of being silently created and never surfaced.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	addNote,
	dismissNote,
	getSessionNotes,
	type Note,
	setNoteLastReadAt,
	updateNote,
} from "@magic-context/core/features/magic-context/storage";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("write"),
				Type.Literal("read"),
				Type.Literal("dismiss"),
				Type.Literal("update"),
			],
			{
				description:
					"Operation to perform. Defaults to 'write' when content is provided, otherwise 'read'.",
			},
		),
	),
	content: Type.Optional(
		Type.String({ description: "Note text to store when action is 'write'." }),
	),
	surface_condition: Type.Optional(
		Type.String({
			description:
				"Smart note condition. Currently unsupported in pi-plugin (requires dreamer integration).",
		}),
	),
	note_id: Type.Optional(
		Type.Number({
			description: "Note ID (required for 'dismiss' and 'update' actions).",
		}),
	),
});

type CtxNoteParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

function formatNoteLine(note: Note): string {
	const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;
	return `- **#${note.id}**${statusSuffix}: ${note.content}`;
}

const DISMISS_FOOTER =
	'\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_id=N)';

export interface CtxNoteToolDeps {
	db: ContextDatabase;
}

export function createCtxNoteTool(
	deps: CtxNoteToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_note",
		label: "Magic Context: Notes",
		description:
			"Save or inspect durable session notes that persist for this session.\n" +
			"Use this for short goals, constraints, decisions, or reminders worth carrying forward.\n\n" +
			"Actions:\n" +
			"- `write`: Append one note. (Smart notes require dreamer; not yet available in pi-plugin.)\n" +
			"- `read`: Show current session notes.\n" +
			"- `dismiss`: Dismiss a note by `note_id`.\n" +
			"- `update`: Update a note by `note_id`.",
		parameters: ParamsSchema,
		async execute(_toolCallId, params: CtxNoteParams, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			const action =
				params.action ??
				(typeof params.content === "string" ? "write" : "read");

			if (action === "write") {
				const content = params.content?.trim();
				if (!content)
					return err("Error: 'content' is required when action is 'write'.");

				if (params.surface_condition?.trim()) {
					return err(
						"Error: Smart notes (surface_condition) require dreamer integration, which is not yet available in the pi-plugin. " +
							"Use a plain session note instead.",
					);
				}

				const note = addNote(deps.db, "session", { sessionId, content });
				return ok(`Saved session note #${note.id}.`);
			}

			if (action === "dismiss") {
				if (typeof params.note_id !== "number") {
					return err("Error: 'note_id' is required when action is 'dismiss'.");
				}
				const dismissed = dismissNote(deps.db, params.note_id);
				return ok(
					dismissed
						? `Note #${params.note_id} dismissed.`
						: `Note #${params.note_id} not found or already dismissed.`,
				);
			}

			if (action === "update") {
				if (typeof params.note_id !== "number") {
					return err("Error: 'note_id' is required when action is 'update'.");
				}
				const newContent = params.content?.trim();
				if (!newContent) {
					return err("Error: 'content' is required to update a note.");
				}
				const updated = updateNote(deps.db, params.note_id, {
					content: newContent,
				});
				if (!updated) {
					return err(`Note #${params.note_id} not found.`);
				}
				return ok(`Updated note #${params.note_id}: ${newContent}`);
			}

			// read
			const sessionNotes = getSessionNotes(deps.db, sessionId);

			// Best-effort watermark write so any future note nudge logic
			// can suppress reminders when the agent has already seen notes.
			try {
				setNoteLastReadAt(deps.db, sessionId);
			} catch {
				// ignore — watermark is a hint, not correctness
			}

			if (sessionNotes.length === 0) {
				return ok("## Notes\n\nNo session notes.");
			}

			const body = sessionNotes.map(formatNoteLine).join("\n");
			return ok(`## Session Notes\n\n${body}${DISMISS_FOOTER}`);
		},
	};
}
