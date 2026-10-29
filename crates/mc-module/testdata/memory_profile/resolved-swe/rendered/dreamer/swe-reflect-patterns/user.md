## Task: Reflect on recurring patterns

**Project:** ⟦projectIdentity⟧

The host grouped this project's historian events by affected surface and correction source, across sessions, and attached the friction windows its gate flagged. Decide which groups show a recurring pattern worth one durable memory.

### Event groups
#### ⟦group.kind⟧ · ⟦group.key⟧ (⟦group.eventCount⟧ events across ⟦group.sessionCount⟧ sessions)
- e⟦event.id⟧ session=⟦event.sessionId⟧ messages=⟦event.messageIds⟧ — ⟦event.summary⟧ (⟦event.fieldKey⟧: ⟦event.fieldValue⟧)
  linked memory: #⟦event.linkedMemoryId⟧ [⟦event.linkedMemoryCategory⟧] ⟦event.linkedMemoryContent⟧

### Friction windows
#### f⟦friction.id⟧ session=⟦friction.sessionId⟧
⟦friction.window⟧

### What to write
- The same external limit hit again (`causal_incident` events on one surface with one cause) → route="memory", category="CONSTRAINTS". If an event already shows a linked memory for that limit, do not write it again; cite the new events only if they change the limit.
- A strategy abandoned for the same reason more than once (`trajectory_correction`), or the user correcting the same assistant behavior in more than one friction window → route="memory" with the project category it belongs to (one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING), usually PROJECT_RULES.
- A recurring correction that is about the user rather than this project → route="observation" with the user category it belongs to (one of COMMUNICATION, PREFERENCES, BOUNDARIES, WORKING_STYLE, IDENTITY, ENGINEERING_PRACTICE, DEV_ENVIRONMENT).
- Corrections that came from the user (correction_source=user, and friction windows) are the strongest evidence. self_review alone rarely justifies a memory.

### Extraction rules
- Write actionable present-tense statements for future agents.
- Write in plain prose with NO quotation marks at all — not around the user's words, and not around illustrative trigger words. Describe trigger conditions directly (write: when the user asks you to investigate or diagnose without requesting a fix — not: when the user says "investigate"). A learning containing any quotation marks is rejected.
- Zero learnings is acceptable and should be represented by an empty learnings block.

Return only XML in this exact shape:
<learnings>
  <learning route="memory" category="CONSTRAINTS" evidence="e12,e40,f3">one durable actionable statement</learning>
  <learning route="observation" category="ENGINEERING_PRACTICE" evidence="f3,f9">one recurring user trait</learning>
</learnings>