/**
 * Pi-side wrapper for the `ctx_note` tool.
 *
 * Action surface mirrors OpenCode's `packages/plugin/src/tools/ctx-note/tools.ts`:
 *   - write: append a session note OR a smart note (when surface_condition is set)
 *   - read: show active session notes + ready smart notes by default; supports `filter`
 *   - dismiss: dismiss a note by note_id
 *   - update: update a note's content and/or surface_condition by note_id
 *
 * Smart notes (with `surface_condition`) are project-scoped and evaluated
 * by the dreamer during nightly runs. When dreamer is disabled in config,
 * we reject smart-note writes with a clear message — silent creation
 * would leave the note stuck `pending` forever with no path to surface.
 *
 * Parity reference (OpenCode):
 *   `tools/ctx-note/tools.ts` for the action surface
 *   `tools/ctx-note/types.ts` for filter/parameter shapes
 *   `features/magic-context/storage-notes.ts` for the underlying storage
 */

import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	addNote,
	dismissNote,
	getNotes,
	type Note,
	type NoteStatus,
	setNoteLastReadAt,
	updateNote,
} from "@magic-context/core/features/magic-context/storage";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

const FILTER_VALUES = [
	"active",
	"pending",
	"ready",
	"dismissed",
	"all",
] as const;
type CtxNoteReadFilter = (typeof FILTER_VALUES)[number];

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
				"Open-ended condition for smart notes. When provided, creates a project-scoped smart note that the dreamer evaluates nightly. The note surfaces when the condition is met.",
		}),
	),
	note_id: Type.Optional(
		Type.Number({
			description: "Note ID (required for 'dismiss' and 'update' actions).",
		}),
	),
	filter: Type.Optional(
		Type.Union(
			FILTER_VALUES.map((value) => Type.Literal(value)),
			{
				description:
					"Optional read filter. Defaults to active session notes + ready smart notes. Use 'all' to inspect every status or 'pending' to inspect unsurfaced smart notes.",
			},
		),
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
	if (note.type === "smart") {
		// For smart notes, surface the condition / readyReason alongside
		// the note content so the agent can act on it. When the note is
		// `ready`, we prefer `readyReason` (set by dreamer at surfacing
		// time) over the original `surfaceCondition`.
		const conditionLine =
			note.status === "ready"
				? (note.readyReason ?? note.surfaceCondition ?? "Condition satisfied")
				: (note.surfaceCondition ?? "No condition recorded");
		const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;
		return `- **#${note.id}**${statusSuffix}: ${note.content}\n  *Condition*: ${conditionLine}`;
	}
	const statusSuffix = note.status === "active" ? "" : ` (${note.status})`;
	return `- **#${note.id}**${statusSuffix}: ${note.content}`;
}

const DISMISS_FOOTER =
	'\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_id=N)';

export interface CtxNoteToolDeps {
	db: ContextDatabase;
	/** When true, smart notes (with `surface_condition`) are accepted and
	 *  the dreamer will evaluate them. When false, smart-note writes are
	 *  rejected because they'd be stuck `pending` forever with no
	 *  evaluator. */
	dreamerEnabled?: boolean;
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
			"- `write`: Append one note. Optionally provide `surface_condition` to create a smart note.\n" +
			"- `read`: Show current notes. Defaults to active session notes + ready smart notes; use `filter` to inspect all, pending, ready, active, or dismissed notes.\n" +
			"- `dismiss`: Dismiss a note by `note_id`.\n" +
			"- `update`: Update a note by `note_id`.\n\n" +
			"**Smart Notes**: When `surface_condition` is provided with `write`, the note becomes a project-scoped smart note. " +
			"The dreamer evaluates smart note conditions during nightly runs and surfaces them when conditions are met. " +
			'Example: `ctx_note(action="write", content="Implement X because Y", surface_condition="When PR #42 is merged in this repo")`',
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

				const surfaceCondition = params.surface_condition?.trim();
				if (surfaceCondition) {
					if (deps.dreamerEnabled !== true) {
						return err(
							"Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.",
						);
					}
					const projectIdentity = resolveProjectIdentity(ctx.cwd);
					if (!projectIdentity) {
						return err(
							"Error: Could not resolve project identity for smart note.",
						);
					}
					const note = addNote(deps.db, "smart", {
						content,
						projectPath: projectIdentity,
						surfaceCondition,
					});
					return ok(
						`Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${surfaceCondition}`,
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
				const updates: { content?: string; surfaceCondition?: string } = {};
				if (params.content?.trim()) updates.content = params.content.trim();
				if (params.surface_condition?.trim())
					updates.surfaceCondition = params.surface_condition.trim();
				if (!updates.content && !updates.surfaceCondition) {
					return err(
						"Error: Provide 'content' and/or 'surface_condition' to update.",
					);
				}
				const updated = updateNote(deps.db, params.note_id, updates);
				if (!updated) {
					return err(`Note #${params.note_id} not found.`);
				}
				const parts: string[] = [];
				if (updates.content) parts.push(`content: ${updates.content}`);
				if (updates.surfaceCondition)
					parts.push(`condition: ${updates.surfaceCondition}`);
				return ok(`Updated note #${params.note_id}\n- ${parts.join("\n- ")}`);
			}

			// read — IMPORTANT: pass through `undefined` as the default
			// mixed-view marker (matches OpenCode parity). Coercing to
			// "active" here would conflate two distinct semantics:
			// (a) default mixed view = active session notes + READY
			//     smart notes (the "what should I see right now?" view)
			// (b) explicit filter="active" = ALL active notes of both
			//     types (which includes active smart notes that haven't
			//     been promoted to ready yet)
			const sections = readNotes({
				db: deps.db,
				sessionId,
				cwd: ctx.cwd,
				filter: params.filter,
			});

			// Best-effort watermark write so any future note nudge logic
			// can suppress reminders when the agent has already seen notes.
			try {
				setNoteLastReadAt(deps.db, sessionId);
			} catch {
				// ignore — watermark is a hint, not correctness
			}

			if (sections.length === 0) {
				return ok("## Notes\n\nNo notes for the current filter.");
			}

			return ok(`${sections.join("\n\n")}${DISMISS_FOOTER}`);
		},
	};
}

/**
 * Read both session notes and smart notes for the current project, applying
 * the requested filter. The DEFAULT (filter undefined) matches OpenCode's
 * `buildReadSections` mixed-view branch: active session notes + READY
 * smart notes. This is the "what should I act on now?" view.
 *
 * Explicit filter='active' is DIFFERENT — it returns all active notes of
 * BOTH types, including active (not-yet-ready) smart notes. This matches
 * OpenCode parity (see packages/plugin/src/tools/ctx-note/tools.ts:46-95).
 *
 * Returns an array of markdown sections (one per note category that has
 * matches). Caller joins with `\n\n` and appends the dismiss footer.
 */
function readNotes(args: {
	db: ContextDatabase;
	sessionId: string;
	cwd: string;
	filter: CtxNoteReadFilter | undefined;
}): string[] {
	const projectIdentity = resolveProjectIdentity(args.cwd);

	if (args.filter === undefined) {
		// Default mixed view: active session notes + READY smart notes.
		// We split the smart-note status filter (we want ONLY ready,
		// not all active) so the agent doesn't get spammed with
		// pending notes that haven't been validated by dreamer yet.
		const sessionNotes = getNotes(args.db, {
			sessionId: args.sessionId,
			type: "session",
			status: "active",
		});
		const readySmartNotes = projectIdentity
			? getNotes(args.db, {
					projectPath: projectIdentity,
					type: "smart",
					status: "ready",
				})
			: [];
		const sections: string[] = [];
		if (sessionNotes.length > 0) {
			sections.push(
				`## Session Notes\n\n${sessionNotes.map(formatNoteLine).join("\n")}`,
			);
		}
		if (readySmartNotes.length > 0) {
			sections.push(
				`## 🔔 Ready Smart Notes\n\n${readySmartNotes.map(formatNoteLine).join("\n\n")}`,
			);
		}
		return sections;
	}

	// Explicit filter: same status applied to both session and smart
	// notes, exposing all matching state (including pending smart notes
	// when filter='pending' or active smart notes when filter='active').
	const statusByFilter: Record<CtxNoteReadFilter, NoteStatus | NoteStatus[]> = {
		active: "active",
		all: ["active", "pending", "ready", "dismissed"],
		dismissed: "dismissed",
		pending: "pending",
		ready: "ready",
	};
	const status = statusByFilter[args.filter];

	const sessionNotes = getNotes(args.db, {
		sessionId: args.sessionId,
		type: "session",
		status,
	});
	const smartNotes = projectIdentity
		? getNotes(args.db, {
				projectPath: projectIdentity,
				type: "smart",
				status,
			})
		: [];

	const sections: string[] = [];
	if (sessionNotes.length > 0) {
		sections.push(
			`## Session Notes\n\n${sessionNotes.map(formatNoteLine).join("\n")}`,
		);
	}
	if (smartNotes.length > 0) {
		sections.push(
			`## Smart Notes\n\n${smartNotes.map(formatNoteLine).join("\n\n")}`,
		);
	}
	return sections;
}
