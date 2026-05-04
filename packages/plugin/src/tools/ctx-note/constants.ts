export const CTX_NOTE_DESCRIPTION = `Save or inspect durable session notes that persist for this session.
Use this for short goals, constraints, decisions, or reminders worth carrying forward.

Actions:
- \`write\`: Append one note. Optionally provide \`surface_condition\` to create a smart note.
- \`read\`: Show current notes. Defaults to active session notes + ready smart notes; use \`filter\` to inspect all, pending, ready, active, or dismissed notes.
- \`dismiss\`: Dismiss a note by \`note_id\`.
- \`update\`: Update a note by \`note_id\`.

**Smart Notes**: When \`surface_condition\` is provided with \`write\`, the note becomes a project-scoped smart note.
The dreamer evaluates smart note conditions during nightly runs and surfaces them when conditions are met.
Example: \`ctx_note(action="write", content="Implement X because Y", surface_condition="When PR #42 is merged in this repo")\`

Historian reads these notes, deduplicates them, and rewrites the remaining useful notes over time.`;
