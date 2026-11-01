/**
 * Pi-side wrapper for the `ctx_note` tool.
 *
 * Action surface mirrors OpenCode's `packages/plugin/src/tools/ctx-note/tools.ts`:
 *   - write: append a session note OR a smart note (when surface_condition is set)
 *   - read: show active session notes + ready smart notes by default; supports `filter`
 *   - dismiss: dismiss 1–50 notes by note_ids
 *   - update: update one note's content and/or surface_condition (note_ids=[N])
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

import type {
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { UnprovenCachedProjectOwnerError } from "@magic-context/core/features/magic-context/memory/session-identity-decision";
import { getLastIndexedOrdinal } from "@magic-context/core/features/magic-context/message-index";
import {
	compileSurfaceCondition,
	conditionCompileReplySuffix,
	conditionCompileStorageFields,
} from "@magic-context/core/features/magic-context/smart-notes/condition-compiler";
import { wakePlaneStatus } from "@magic-context/core/features/magic-context/smart-notes/wake-plane";
import type {
	ContextDatabase,
	UpdateNoteOptions,
} from "@magic-context/core/features/magic-context/storage";
import {
	addNote,
	dismissNote,
	dismissNotes,
	getNoteByIdInScope,
	getNotes,
	getPendingSmartNotes,
	getReadySmartNotes,
	getSessionNotes,
	type Note,
	type NoteMutationScope,
	type NoteStatus,
	setNoteLastReadAt,
	updateNote,
} from "@magic-context/core/features/magic-context/storage";
import {
	CTX_NOTE_DESCRIPTION,
	NOTES_FILTER_DESCRIPTION,
	SMART_NOTES_DISABLED_REPLY,
	withoutSmartNoteText,
} from "@magic-context/core/tools/ctx-note/constants";
import {
	EMPTY_READ_REPLY,
	formatWriteReply,
	noteTouchedAt,
	renderGlance,
	renderNotesById,
} from "@magic-context/core/tools/ctx-note/render";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const FILTER_VALUES = [
	"active",
	"pending",
	"ready",
	"dismissed",
	"all",
] as const;
type CtxNoteReadFilter = (typeof FILTER_VALUES)[number];

const ParamsSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("write"),
				Type.Literal("read"),
				Type.Literal("dismiss"),
				Type.Literal("update"),
			],
			{
				description: "write | read | update | dismiss.",
			},
		),
		content: Type.String({
			description:
				"Note text for write/update: first line is the title (under 80 chars), then the detail.",
		}),
		surface_condition: Type.Optional(
			Type.String({
				description:
					"Makes this a smart note: a condition an outside checker can verify on its own, periodically — repository state, releases, web pages, anything it can look up — never something only this conversation knows. The note is parked until the condition holds.",
			}),
		),
		note_ids: Type.Array(
			Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			{
				maxItems: 50,
				description:
					"Note ids: one for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list.",
			},
		),
		filter: Type.Optional(
			Type.Union(
				FILTER_VALUES.map((value) => Type.Literal(value)),
				{
					description:
						"Read filter: all, active, pending (unsurfaced smart notes), ready, dismissed. Omitted, it shows active session notes plus every current smart note (pending included); active shows only notes whose stored status is active.",
				},
			),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Rows per read (default 25).",
			}),
		),
		offset: Type.Optional(
			Type.Number({
				description: "Skip this many newest rows (default 0).",
			}),
		),
	},
	{ additionalProperties: true },
);

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

/** Capture the live-tail message ordinal so a note can be traced back to the
 *  conversation that produced it. Best-effort: returns null when there are no
 *  indexed messages yet (ordinal 0) or the lookup fails. Mirrors OpenCode's
 *  packages/plugin/src/tools/ctx-note/tools.ts. */
function captureAnchorOrdinal(
	db: ContextDatabase,
	sessionId: string,
): number | null {
	try {
		const ordinal = getLastIndexedOrdinal(db, sessionId);
		return ordinal > 0 ? ordinal : null;
	} catch {
		return null;
	}
}

const DISMISS_FOOTER =
	'\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_ids=[N])';

function formatDismissResults(
	results: Array<{ noteId: number; outcome: string }>,
): string {
	const dismissedCount = results.filter(
		(result) => result.outcome === "dismissed",
	).length;
	return `Dismissed ${dismissedCount} of ${results.length} notes.\n${results
		.map(
			(result) =>
				`- Note #${result.noteId}: ${result.outcome === "not_owned" ? "not_found" : result.outcome}`,
		)
		.join("\n")}`;
}

function formatNotesById(
	db: ContextDatabase,
	noteIds: readonly number[],
	scope: NoteMutationScope,
	nowMs: number,
): string {
	return renderNotesById(
		noteIds.map((noteId) => ({
			noteId,
			note: getNoteByIdInScope(db, noteId, scope),
		})),
		nowMs,
	);
}

/**
 * Read `note_ids` for targeted reads and mutations. `write` ignores the field
 * and a plain `read` treats an empty list the same as omitting it, because
 * required-field tool surfaces send `[]` where there is nothing to select.
 * A non-empty list on `read` returns those notes in full; `dismiss` accepts
 * one to fifty IDs; `update` addresses exactly one note.
 */
function parseNoteIds(action: string, value: unknown): number[] | string {
	const max = action === "update" ? 1 : 50;
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > max ||
		value.some(
			(id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0,
		)
	) {
		return action === "update"
			? "Error: 'note_ids' must contain exactly one positive integer id when action is 'update'."
			: `Error: 'note_ids' must contain 1 to 50 positive integer ids when action is '${action}'.`;
	}
	return value;
}

/** Default page size for read. Long-running sessions accumulate hundreds of
 *  notes; the glance keeps one short row per note so a large queue stays
 *  readable, and the footer points at the older pages. Mirrors OpenCode's
 *  ctx-note tool. */
const DEFAULT_READ_LIMIT = 25;

/** The tray line appended to a write reply: how many active session notes the
 *  writer now holds and how old the oldest one is. */
function writeTray(
	db: ContextDatabase,
	sessionId: string,
): {
	activeCount: number;
	oldestTouchedAt: number | null;
} {
	const active = getSessionNotes(db, sessionId);
	const oldest = active.reduce<number | null>((min, note) => {
		const touchedAt = noteTouchedAt(note);
		return min === null || touchedAt < min ? touchedAt : min;
	}, null);
	return { activeCount: active.length, oldestTouchedAt: oldest };
}

export interface CtxNoteToolDeps {
	db: ContextDatabase;
	smartNotesEnabled?: boolean;
	/** When true, smart notes (with `surface_condition`) are accepted and
	 *  the dreamer will evaluate them. When false, smart-note writes are
	 *  rejected because they'd be stuck `pending` forever with no
	 *  evaluator. */
	dreamerEnabled?: boolean;
	/** Resolve dreamer enablement from the current cwd at tool-call time. Pi
	 *  registers tools once, but `/cd` can switch to a project with different
	 *  smart-note support. */
	resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
	/** Resolve a directory's project identity, allowing home only when user-level configuration enables it. */
	resolveProjectIdentity?: (
		directory: string,
		ctx: ExtensionContext,
	) => string | undefined | Promise<string | undefined>;
}

export function createCtxNoteTool(
	deps: CtxNoteToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const resolveProject = (directory: string, ctx: ExtensionContext) =>
		deps.resolveProjectIdentity
			? deps.resolveProjectIdentity(directory, ctx)
			: resolveProjectIdentityForSession(directory);
	const parameters = structuredClone(ParamsSchema);
	// The dreamer evaluates smart-note conditions, so a disabled dreamer hides the
	// smart-note argument and text exactly as smart_notes.enabled=false does.
	// Registration happens once, from the boot project's settings; an omitted
	// dreamerEnabled counts as not disabled.
	const smartNoteSurface =
		deps.smartNotesEnabled !== false && deps.dreamerEnabled !== false;
	if (!smartNoteSurface) {
		delete (parameters.properties as Record<string, unknown>).surface_condition;
		(
			parameters.properties.filter as unknown as { description: string }
		).description = NOTES_FILTER_DESCRIPTION;
	}
	return {
		name: "ctx_note",
		label: "Magic Context: Notes",
		description: smartNoteSurface
			? CTX_NOTE_DESCRIPTION
			: withoutSmartNoteText(CTX_NOTE_DESCRIPTION),
		parameters,
		async execute(_toolCallId, params: CtxNoteParams, _signal, _onUpdate, ctx) {
			params = unwrapImitatedReducedArgs(params, ["action", "content"], {
				action: {
					type: "enum",
					values: ["write", "read", "dismiss", "update"],
				},
				content: "string",
				surface_condition: "string",
				note_ids: { type: "array", items: "number", maxItems: 50 },
				filter: { type: "enum", values: FILTER_VALUES },
				limit: "number",
				offset: "number",
			});
			if (
				deps.smartNotesEnabled === false &&
				params.surface_condition !== undefined
			) {
				return err(SMART_NOTES_DISABLED_REPLY);
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const dreamerEnabled =
				deps.resolveDreamerEnabled?.(ctx) ?? deps.dreamerEnabled;
			// Infer write only on NON-EMPTY content. GPT-family models fill every
			// optional param (content:"" for a read), so a bare `typeof === "string"`
			// check would mis-infer `write` and then reject the empty content.
			const action =
				params.action ?? (params.content?.trim() ? "write" : "read");
			// An empty list on read is the plain listing read, not a targeted
			// one: required-field providers always send the field, so `[]`
			// must behave like omitting it. Only a non-empty list selects the
			// full-body read; dismiss and update genuinely need ids.
			const targetedReadIds =
				action === "read" &&
				Array.isArray(params.note_ids) &&
				params.note_ids.length === 0
					? undefined
					: params.note_ids;
			const noteIds =
				action === "dismiss" ||
				action === "update" ||
				(action === "read" && targetedReadIds !== undefined)
					? parseNoteIds(action, targetedReadIds)
					: undefined;
			if (typeof noteIds === "string") return err(noteIds);
			let projectIdentity: string | undefined;
			let ownerUnavailable: UnprovenCachedProjectOwnerError | undefined;
			try {
				projectIdentity = await resolveProject(ctx.cwd, ctx);
			} catch (error) {
				if (!(error instanceof UnprovenCachedProjectOwnerError)) throw error;
				ownerUnavailable = error;
			}
			const sessionOnlyTargets =
				Array.isArray(noteIds) &&
				noteIds.every(
					(id) =>
						getNoteByIdInScope(deps.db, id, {
							sessionId,
							projectPath: undefined,
						})?.type === "session",
				);
			if (!projectIdentity && Array.isArray(noteIds) && !sessionOnlyTargets)
				return ok(
					(
						ownerUnavailable ?? new UnprovenCachedProjectOwnerError(undefined)
					).refusal("ctx_note", action),
				);

			if (action === "write") {
				const content = params.content?.trim();
				if (!content)
					return err("Error: 'content' is required when action is 'write'.");

				// Anchor the note to the live conversation tail so it can be
				// traced back later via ctx_expand. Best-effort — null when
				// there's no indexed tail yet.
				const anchorOrdinal = captureAnchorOrdinal(deps.db, sessionId);

				const surfaceCondition = params.surface_condition?.trim();
				if (surfaceCondition) {
					if ((await wakePlaneStatus()) === "present") {
						const note = addNote(deps.db, "session", {
							sessionId,
							content,
							anchorOrdinal,
						});
						return ok(
							`${formatWriteReply(note.id, writeTray(deps.db, sessionId), Date.now())}\nwake plane active — create a scheduled wake instead; stored as a plain note.`,
						);
					}
					if (dreamerEnabled !== true) {
						return err(
							"Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.",
						);
					}
					if (!projectIdentity) {
						if (ownerUnavailable)
							return ok(ownerUnavailable.refusal("ctx_note", action));
						return err(
							"Error: Could not resolve project identity for smart note.",
						);
					}
					const compilation = await compileSurfaceCondition(surfaceCondition, {
						projectPath: ctx.cwd,
					});
					const note = addNote(deps.db, "smart", {
						content,
						sessionId,
						projectPath: projectIdentity,
						surfaceCondition,
						anchorOrdinal,
						...conditionCompileStorageFields(compilation),
					});
					return ok(
						`Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${surfaceCondition}${conditionCompileReplySuffix(compilation)}`,
					);
				}

				const note = addNote(deps.db, "session", {
					sessionId,
					content,
					anchorOrdinal,
				});
				return ok(
					formatWriteReply(note.id, writeTray(deps.db, sessionId), Date.now()),
				);
			}

			if (action === "dismiss") {
				if (!projectIdentity && !sessionOnlyTargets) {
					return err(
						"Error: Could not resolve project identity for note dismiss.",
					);
				}
				const ids = noteIds as number[];
				if (ids.length > 1) {
					return ok(
						formatDismissResults(
							dismissNotes(deps.db, ids, {
								projectPath: projectIdentity,
								sessionId,
							}),
						),
					);
				}
				const dismissed = dismissNote(deps.db, ids[0], {
					projectPath: projectIdentity,
					sessionId,
				});
				return dismissed
					? ok(`Note #${ids[0]} dismissed.`)
					: err(
							`Error: Note #${ids[0]} not found in your session/project or already dismissed.`,
						);
			}

			if (action === "update") {
				const noteId = (noteIds as number[])[0];
				const updates: UpdateNoteOptions = {};
				if (params.content?.trim()) updates.content = params.content.trim();
				let compilation:
					| Awaited<ReturnType<typeof compileSurfaceCondition>>
					| undefined;
				if (params.surface_condition?.trim()) {
					const existing = getNoteByIdInScope(deps.db, noteId, {
						projectPath: projectIdentity,
						sessionId,
					});
					if (existing?.type === "session")
						return err(
							"Error: Only a note created with a condition can have one. Write a new note with surface_condition, and dismiss this one.",
						);
					const surfaceCondition = params.surface_condition.trim();
					updates.surfaceCondition = surfaceCondition;
					compilation = await compileSurfaceCondition(surfaceCondition, {
						projectPath: ctx.cwd,
					});
					Object.assign(updates, conditionCompileStorageFields(compilation));
				}
				if (!updates.content && !updates.surfaceCondition) {
					return err(
						"Error: Provide 'content' and/or 'surface_condition' to update.",
					);
				}
				if (!projectIdentity && !sessionOnlyTargets) {
					return err(
						"Error: Could not resolve project identity for note update.",
					);
				}
				const updated = updateNote(deps.db, noteId, updates, {
					projectPath: projectIdentity,
					sessionId,
				});
				if (!updated) {
					return err(
						`Error: Note #${noteId} not found in your session/project.`,
					);
				}
				const parts: string[] = [];
				if (updates.content) parts.push(`content: ${updates.content}`);
				if (updates.surfaceCondition)
					parts.push(`condition: ${updates.surfaceCondition}`);
				return ok(
					`Updated note #${noteId}\n- ${parts.join("\n- ")}${compilation ? conditionCompileReplySuffix(compilation) : ""}`,
				);
			}

			// read — IMPORTANT: pass through `undefined` as the default
			// mixed-view marker (matches OpenCode parity). Coercing to
			// "active" here would conflate two distinct semantics:
			// (a) default mixed view = active session notes + READY
			//     smart notes (the "what should I see right now?" view)
			// (b) explicit filter="active" = ALL active notes of both
			//     types (which includes active smart notes that haven't
			//     been promoted to ready yet)
			const limit =
				typeof params.limit === "number" && params.limit > 0
					? Math.floor(params.limit)
					: DEFAULT_READ_LIMIT;
			const offset =
				typeof params.offset === "number" && params.offset > 0
					? Math.floor(params.offset)
					: 0;
			if (Array.isArray(noteIds) && !projectIdentity && !sessionOnlyTargets) {
				return err("Error: Could not resolve project identity for note read.");
			}
			const nowMs = Date.now();
			const body = Array.isArray(noteIds)
				? formatNotesById(
						deps.db,
						noteIds,
						{ projectPath: projectIdentity, sessionId },
						nowMs,
					)
				: renderGlance(
						readGlanceNotes({
							db: deps.db,
							sessionId,
							cwd: ctx.cwd,
							resolveProjectIdentity: () => projectIdentity,
							filter: params.filter,
						}),
						{ limit, offset, nowMs },
					);

			// Best-effort watermark write so any future note nudge logic
			// can suppress reminders when the agent has already seen notes.
			try {
				setNoteLastReadAt(deps.db, sessionId);
			} catch {
				// ignore — watermark is a hint, not correctness
			}

			if (body === EMPTY_READ_REPLY) {
				return ok(EMPTY_READ_REPLY);
			}

			// Only surface the anchor hint when at least one note carries one.
			const anchorHint = body.includes("↳ @msg ")
				? "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
				: "";
			return ok(`${body}${anchorHint}${DISMISS_FOOTER}`);
		},
	};
}

/**
 * Read both session notes and smart notes for the current project, applying
 * the requested filter. The DEFAULT (filter undefined) matches OpenCode's
 * mixed view: active session notes + every smart note, ready or still parked.
 * This is the "what should I act on now?" view.
 *
 * Explicit filter='active' is DIFFERENT — it returns all active notes of
 * BOTH types, including active (not-yet-ready) smart notes. This matches
 * OpenCode parity (see packages/plugin/src/tools/ctx-note/tools.ts).
 *
 * Returns the notes for the glance renderer to order and page.
 */
function readGlanceNotes(args: {
	db: ContextDatabase;
	sessionId: string;
	cwd: string;
	resolveProjectIdentity: (directory: string) => string | undefined;
	filter: CtxNoteReadFilter | undefined;
}): Note[] {
	const projectIdentity = args.resolveProjectIdentity(args.cwd);

	if (args.filter === undefined) {
		// Default mixed view: active session notes + every smart note.
		const sessionNotes = getSessionNotes(args.db, args.sessionId);
		const readySmartNotes = projectIdentity
			? getReadySmartNotes(args.db, projectIdentity)
			: [];
		const pendingSmartNotes = projectIdentity
			? getPendingSmartNotes(args.db, projectIdentity)
			: [];
		return [...sessionNotes, ...readySmartNotes, ...pendingSmartNotes];
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
	return [...sessionNotes, ...smartNotes];
}
