## Task: Retrospective Learning

**Project:** ⟦projectIdentity⟧

The host detected possible user friction in the pre-rendered window below. Use it plus ctx_search (if helpful) to decide whether there is a recurring root cause and recurring assistant behavior worth remembering.

### Friction window
⟦frictionWindow⟧

### Corroborating historian events
- 1970-01-01T00:00:00.000Z session=⟦event.sessionId⟧ kind=⟦event.kind⟧ — ⟦event.fieldKey⟧: ⟦event.fieldValue⟧

### Extraction rules
- Extract only durable, recurring learnings. A single annoyed/corrective message is noise.
- Write actionable present-tense corrections for future agents.
- Do NOT quote the user, include dates, or preserve anger/frustration wording.
- Write in plain prose with NO quotation marks at all — not around the user's words, and not around illustrative trigger words. Describe trigger conditions directly (write: when the user asks you to investigate or diagnose without requesting a fix — not: when the user says "investigate"). A learning containing any quotation marks is rejected.
- Use route="memory" for project-specific agent behavior/rules, with category one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING.
- Use route="observation" only for recurring user workflow/preferences that belong in the global user profile.
- Zero learnings is acceptable and should be represented by an empty learnings block.

Return only XML in this exact shape:
<learnings>
  <learning route="memory" category="PROJECT_RULES">one durable actionable correction</learning>
  <learning route="observation">one recurring user preference</learning>
</learnings>