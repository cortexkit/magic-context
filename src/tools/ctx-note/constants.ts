export const CTX_NOTE_DESCRIPTION = `Save or inspect durable session notes that persist for this session.
Use this for short goals, constraints, decisions, or reminders worth carrying forward.

Actions:
- \`write\`: Append one note.
- \`read\`: Show current notes.
- \`clear\`: Remove all notes.

Historian reads these notes, deduplicates them, and rewrites the remaining useful notes over time.`;
