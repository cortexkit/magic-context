export const CTX_NOTE_DESCRIPTION = `Session notes are pending intentions: work you intend to return to, with its findings attached.

Use notes for:
- A finding to revisit when you return to the intended work
- A decision with its reasoning, when follow-up work remains
- A backlog item with evidence already found
- Something the user explicitly asks you to note

Don't use notes for: the next few steps; a plan you are actively executing; restart/fold insurance; or a record of how things stand (world-state, a design at a point in time) with nothing you intend to do about it — that goes stale silently; a fact worth keeping is memory, the rest is nothing. Use todos for active work. If the detail already lives in a file, record the path and what to inspect — don't copy the file into a note. Durable project facts belong in ctx_memory, not notes.

First line is the title (under 80 chars), followed by detail. Operations:
- write: save a new note (content required)
- read: one row per note — \`#id · age · title\` — ready smart notes first, then newest; rows untouched 30+ days are marked stale. Pass note_ids to read full bodies; limit/offset page; filter selects other statuses.
- update: rewrite one note (note_ids=[N]). The new content replaces the whole note, so include everything you want to keep.
- dismiss: retire 1–50 notes (note_ids). Dismiss a note when its work lands or is abandoned; a queue you never dismiss from stops being read.
- surface_condition: make it a smart note — an outside checker periodically tests the condition using only externally verifiable signals (GitHub state, files, git, releases, web), never this conversation or future actions; the note is parked until the condition holds.`;

export const SMART_NOTES_DISABLED_REPLY =
    "Error: Smart notes are disabled; surface_condition is unavailable.";
export const NOTES_FILTER_DESCRIPTION =
    "Read filter: all, active, pending, ready, dismissed. Omitted: active session notes plus every current project note; active shows only active-status notes.";

/** Remove the capability clauses from either built-in note description, leaving ordinary notes intact. */
export function withoutSmartNoteText(description: string): string {
    return description
        .replace("ready smart notes first, then newest", "newest first")
        .split("\n- surface_condition:")[0]
        .split(" surface_condition parks")[0];
}
