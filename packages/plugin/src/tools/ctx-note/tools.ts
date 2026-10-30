import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { describeUnresolvedProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { UnprovenCachedProjectOwnerError } from "../../features/magic-context/memory/session-identity-decision";
import { getLastIndexedOrdinal } from "../../features/magic-context/message-index";
import {
    compileSurfaceCondition,
    conditionCompileReplySuffix,
    conditionCompileStorageFields,
} from "../../features/magic-context/smart-notes/condition-compiler";
import { wakePlaneStatus } from "../../features/magic-context/smart-notes/wake-plane";
import {
    addNote,
    dismissNote,
    dismissNotes,
    getNotes,
    getPendingSmartNotes,
    getReadySmartNotes,
    getSessionNotes,
    type Note,
    setNoteLastReadAt,
    type UpdateNoteOptions,
    updateNote,
} from "../../features/magic-context/storage";
import type { NoteMutationScope } from "../../features/magic-context/storage-notes";
import {
    getNoteByIdInScope,
    SESSION_NOTE_CONDITION_ERROR,
} from "../../features/magic-context/storage-notes";
import {
    projectNeedsSingleStoreMigration,
    renderSingleStoreMigrationRequiredRefusal,
} from "../../hooks/magic-context/single-store-refusal";
import type { Database } from "../../shared/sqlite";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    CTX_NOTE_DESCRIPTION,
    NOTES_FILTER_DESCRIPTION,
    SMART_NOTES_DISABLED_REPLY,
    withoutSmartNoteText,
} from "./constants";
import {
    EMPTY_READ_REPLY,
    formatWriteReply,
    noteTouchedAt,
    renderGlance,
    renderNotesById,
} from "./render";
import type { CtxNoteArgs, CtxNoteReadFilter } from "./types";

export { CTX_NOTE_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxNoteToolDeps {
    db: Database;
    dreamerEnabled?: boolean;
    smartNotesEnabled?: boolean;
    /**
     * Resolve the project identity for the session's directory at call time.
     * See CtxMemoryToolDeps.resolveProjectPath for why this is a function.
     * Optional — when undefined, smart-note creation is rejected with an
     * explanatory error.
     */
    resolveProjectPath?: (
        directory: string,
        sessionId: string,
    ) => string | undefined | Promise<string | undefined>;
}

/** Capture the live-tail message ordinal so a note can be traced back to the
 *  conversation that produced it. Best-effort: returns null when there are no
 *  indexed messages yet (ordinal 0) or the lookup fails, in which case the note
 *  is stored without an anchor. */
function captureAnchorOrdinal(db: Database, sessionId: string): number | null {
    try {
        const ordinal = getLastIndexedOrdinal(db, sessionId);
        return ordinal > 0 ? ordinal : null;
    } catch {
        return null;
    }
}

const DISMISS_FOOTER = '\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_ids=[N])';

/** Default page size for read. Long-running sessions accumulate hundreds of
 *  notes; the glance keeps one short row per note so a large queue stays
 *  readable, and the footer points at the older pages. */
const DEFAULT_READ_LIMIT = 25;

/** The notes a read shows. The default view is the tray: active session notes
 *  plus every smart note, ready or still parked. An explicit filter selects one
 *  status across both types. */
function readGlanceNotes(args: {
    db: Database;
    sessionId: string;
    projectIdentity?: string;
    filter?: CtxNoteReadFilter;
}): Note[] {
    if (args.filter === undefined) {
        const sessionNotes = getSessionNotes(args.db, args.sessionId);
        const readySmartNotes = args.projectIdentity
            ? getReadySmartNotes(args.db, args.projectIdentity)
            : [];
        const pendingSmartNotes = args.projectIdentity
            ? getPendingSmartNotes(args.db, args.projectIdentity)
            : [];
        return [...sessionNotes, ...readySmartNotes, ...pendingSmartNotes];
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
    return [...sessionNotes, ...smartNotes];
}

/** The tray line appended to a write reply: how many active session notes the
 *  writer now holds and how old the oldest one is. */
function writeTray(
    db: Database,
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

const ctxNoteArgsShape = {
    action: tool.schema
        .enum(["write", "read", "dismiss", "update"])
        .describe("write | read | update | dismiss."),
    content: tool.schema
        .string()
        .describe(
            "Note text for write/update: first line is the title (under 80 chars), then the detail.",
        ),
    surface_condition: tool.schema
        .string()
        .optional()
        .describe(
            "Makes this a smart note: a condition an outside checker can verify on its own, periodically — repository state, releases, web pages, anything it can look up — never something only this conversation knows. The note is parked until the condition holds.",
        ),
    filter: tool.schema
        .enum(["all", "active", "pending", "ready", "dismissed"])
        .optional()
        .describe(
            "Read filter: all, active, pending (unsurfaced smart notes), ready, dismissed. Omitted, it shows active session notes plus every current smart note (pending included); active shows only notes whose stored status is active.",
        ),
    limit: tool.schema.number().optional().describe("Rows per read (default 25)."),
    offset: tool.schema.number().optional().describe("Skip this many newest rows (default 0)."),
    note_ids: tool.schema
        .array(tool.schema.number().int().min(1))
        .max(50)
        .describe(
            "Note ids: one for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list.",
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxNoteArgsSchema = tool.schema.object(ctxNoteArgsShape).passthrough();

function formatDismissResults(results: Array<{ noteId: number; outcome: string }>): string {
    const dismissedCount = results.filter((result) => result.outcome === "dismissed").length;
    return `Dismissed ${dismissedCount} of ${results.length} notes.\n${results
        .map(
            (result) =>
                `- Note #${result.noteId}: ${result.outcome === "not_owned" ? "not_found" : result.outcome}`,
        )
        .join("\n")}`;
}

function formatNotesById(
    db: Database,
    noteIds: readonly number[],
    scope: NoteMutationScope,
    nowMs: number,
): string {
    return renderNotesById(
        noteIds.map((noteId) => ({ noteId, note: getNoteByIdInScope(db, noteId, scope) })),
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
        value.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)
    ) {
        return action === "update"
            ? "Error: 'note_ids' must contain exactly one positive integer id when action is 'update'."
            : `Error: 'note_ids' must contain 1 to 50 positive integer ids when action is '${action}'.`;
    }
    return value;
}

function createCtxNoteTool(deps: CtxNoteToolDeps): ToolDefinition {
    const { surface_condition: _condition, ...plainArgs } = ctxNoteArgsShape;
    // Smart notes are evaluated by the dreamer, so a disabled dreamer hides the
    // smart-note argument and text just as smart_notes.enabled=false does. An
    // omitted dreamerEnabled is treated as not disabled, keeping the full surface.
    const smartNoteSurface = deps.smartNotesEnabled !== false && deps.dreamerEnabled !== false;
    return tool({
        description: smartNoteSurface
            ? CTX_NOTE_DESCRIPTION
            : withoutSmartNoteText(CTX_NOTE_DESCRIPTION),
        args: smartNoteSurface
            ? ctxNoteArgsShape
            : {
                  ...plainArgs,
                  filter: ctxNoteArgsShape.filter.describe(NOTES_FILTER_DESCRIPTION),
              },
        async execute(rawArgs: CtxNoteArgs, toolContext) {
            const parsedArgs = ctxNoteArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxNoteArgs;
            args = unwrapImitatedReducedArgs(args, ["action", "content"], {
                action: { type: "enum", values: ["write", "read", "dismiss", "update"] },
                content: "string",
                surface_condition: "string",
                filter: {
                    type: "enum",
                    values: ["all", "active", "pending", "ready", "dismissed"],
                },
                limit: "number",
                offset: "number",
                note_ids: { type: "array", items: "number", maxItems: 50 },
            });
            if (deps.smartNotesEnabled === false && args.surface_condition !== undefined) {
                return SMART_NOTES_DISABLED_REPLY;
            }
            const sessionId = toolContext.sessionID;
            // Infer write only on NON-EMPTY content. GPT-family models fill every
            // optional param (content:"" for a read), so a bare `typeof === "string"`
            // check would mis-infer `write` and then reject the empty content.
            const action = args.action ?? (args.content?.trim() ? "write" : "read");
            // An empty list on read is the plain listing read, not a targeted
            // one: required-field providers always send the field, so `[]`
            // must behave like omitting it. Only a non-empty list selects the
            // full-body read; dismiss and update genuinely need ids.
            const targetedReadIds =
                action === "read" && Array.isArray(args.note_ids) && args.note_ids.length === 0
                    ? undefined
                    : args.note_ids;
            const noteIds =
                action === "dismiss" ||
                action === "update" ||
                (action === "read" && targetedReadIds !== undefined)
                    ? parseNoteIds(action, targetedReadIds)
                    : undefined;
            if (typeof noteIds === "string") return noteIds;
            const wakePlaneActive =
                action === "write" &&
                Boolean(args.surface_condition?.trim()) &&
                (await wakePlaneStatus()) === "present";
            const _surfaceCondition = wakePlaneActive ? undefined : args.surface_condition?.trim();

            // Use the same session decision as project-memory, including unpinned worktrees.
            let projectIdentity: string | undefined;
            let ownerUnavailable: UnprovenCachedProjectOwnerError | undefined;
            try {
                projectIdentity = await deps.resolveProjectPath?.(
                    toolContext.directory,
                    toolContext.sessionID,
                );
            } catch (error) {
                if (!(error instanceof UnprovenCachedProjectOwnerError)) throw error;
                ownerUnavailable = error;
            }
            const sessionOnlyTargets =
                Array.isArray(noteIds) &&
                noteIds.every(
                    (id) =>
                        getNoteByIdInScope(deps.db, id, { sessionId, projectPath: undefined })
                            ?.type === "session",
                );
            if (!projectIdentity && Array.isArray(noteIds) && !sessionOnlyTargets)
                return (ownerUnavailable ?? new UnprovenCachedProjectOwnerError(undefined)).refusal(
                    "ctx_note",
                    action,
                );

            if (projectIdentity && projectNeedsSingleStoreMigration(deps.db, projectIdentity)) {
                return renderSingleStoreMigrationRequiredRefusal();
            }

            if (action === "write") {
                const content = args.content?.trim();
                if (!content) {
                    return "Error: 'content' is required when action is 'write'.";
                }

                // Anchor the note to the live conversation tail so it can be
                // traced back later. The agent reads this as the upper bound and
                // expands `anchorOrdinal - x .. anchorOrdinal` via ctx_expand at
                // its own discretion. Best-effort: 0 (no indexed messages yet)
                // stores null and the note simply renders without an anchor.
                const anchorOrdinal = captureAnchorOrdinal(deps.db, sessionId);

                // Smart note — project-scoped with condition evaluation by dreamer
                if (args.surface_condition?.trim()) {
                    if (wakePlaneActive) {
                        const note = addNote(deps.db, "session", {
                            sessionId,
                            content,
                            anchorOrdinal,
                        });
                        return `${formatWriteReply(note.id, writeTray(deps.db, sessionId), Date.now())}\nwake plane active — create a scheduled wake instead; stored as a plain note.`;
                    }
                    if (!deps.dreamerEnabled) {
                        return "Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.";
                    }
                    if (!projectIdentity) {
                        if (ownerUnavailable) return ownerUnavailable.refusal("ctx_note", action);
                        return `Error: Could not resolve project identity for smart note: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
                    }
                    const smartSurfaceCondition = args.surface_condition.trim();
                    const compilation = await compileSurfaceCondition(smartSurfaceCondition, {
                        projectPath: toolContext.directory,
                    });
                    const note = addNote(deps.db, "smart", {
                        content,
                        projectPath: projectIdentity,
                        sessionId,
                        surfaceCondition: smartSurfaceCondition,
                        anchorOrdinal,
                        ...conditionCompileStorageFields(compilation),
                    });
                    return `Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${smartSurfaceCondition}${conditionCompileReplySuffix(compilation)}`;
                }

                // Simple session note
                const note = addNote(deps.db, "session", { sessionId, content, anchorOrdinal });
                return formatWriteReply(note.id, writeTray(deps.db, sessionId), Date.now());
            }

            if (action === "dismiss") {
                if (!projectIdentity && !sessionOnlyTargets) {
                    return `Error: Could not resolve project identity for note dismiss: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
                }
                const ids = noteIds as number[];
                if (ids.length === 1) {
                    const dismissed = dismissNote(deps.db, ids[0], {
                        projectPath: projectIdentity,
                        sessionId,
                    });
                    return dismissed
                        ? `Note #${ids[0]} dismissed.`
                        : `Error: Note #${ids[0]} not found in your session/project or already dismissed.`;
                }
                return formatDismissResults(
                    dismissNotes(deps.db, ids, {
                        projectPath: projectIdentity,
                        sessionId,
                    }),
                );
            }

            if (action === "update") {
                const noteId = (noteIds as number[])[0];
                const updates: UpdateNoteOptions = {};
                if (args.content?.trim()) updates.content = args.content.trim();
                let compilation: Awaited<ReturnType<typeof compileSurfaceCondition>> | undefined;
                if (args.surface_condition?.trim()) {
                    const existing = getNoteByIdInScope(deps.db, noteId, {
                        projectPath: projectIdentity,
                        sessionId,
                    });
                    if (existing?.type === "session")
                        return `Error: ${SESSION_NOTE_CONDITION_ERROR}`;
                }
                if (args.surface_condition?.trim()) {
                    const surfaceCondition = args.surface_condition.trim();
                    updates.surfaceCondition = surfaceCondition;
                    compilation = await compileSurfaceCondition(surfaceCondition, {
                        projectPath: toolContext.directory,
                    });
                    Object.assign(updates, conditionCompileStorageFields(compilation));
                }

                if (!updates.content && !updates.surfaceCondition) {
                    return "Error: Provide 'content' and/or 'surface_condition' to update.";
                }
                if (!projectIdentity && !sessionOnlyTargets) {
                    return `Error: Could not resolve project identity for note update: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
                }
                const updated = updateNote(deps.db, noteId, updates, {
                    projectPath: projectIdentity,
                    sessionId,
                });
                if (!updated) {
                    return `Error: Note #${noteId} not found in your session/project or has no compatible fields to update.`;
                }
                const parts: string[] = [];
                if (updates.content) parts.push(`Content: ${updates.content}`);
                if (updates.surfaceCondition) parts.push(`Condition: ${updates.surfaceCondition}`);
                return `Updated note #${noteId}:\n${parts.join("\n")}${compilation ? conditionCompileReplySuffix(compilation) : ""}`;
            }

            const limit =
                typeof args.limit === "number" && args.limit > 0
                    ? Math.floor(args.limit)
                    : DEFAULT_READ_LIMIT;
            const offset =
                typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
            if (Array.isArray(noteIds) && !projectIdentity && !sessionOnlyTargets) {
                return `Error: Could not resolve project identity for note read: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
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
                          filter: args.filter,
                          projectIdentity,
                          sessionId,
                      }),
                      { limit, offset, nowMs },
                  );

            // Record read watermark so note-nudger can suppress reminders
            // when the agent has already seen notes in recent context and no
            // new notes have been written since.
            try {
                setNoteLastReadAt(deps.db, sessionId);
            } catch {
                // Best-effort — the watermark is a suppression hint, not correctness.
            }

            if (body === EMPTY_READ_REPLY) {
                return EMPTY_READ_REPLY;
            }

            // Only surface the anchor hint when at least one note carries one,
            // so notes written before anchoring (or with no indexed tail) don't
            // advertise a capability their output doesn't show.
            const anchorHint = body.includes("↳ @msg ")
                ? "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
                : "";
            return body + anchorHint + DISMISS_FOOTER;
        },
    });
}

export function createCtxNoteTools(deps: CtxNoteToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_note: createCtxNoteTool(deps),
    };
}
