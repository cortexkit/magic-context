## Task: Review User Memory Candidates

You are reviewing observations about a human user to decide which patterns are real and persistent, and which user category each belongs to.

### Current Stable User Memories
- Memory #⟦memory.id⟧ [⟦memory.categoryTag⟧]: "⟦memory.content⟧"

### Candidate Observations (from recent historian runs)
- Candidate #⟦candidate.id⟧ [⟦candidate.categoryTag⟧] [session ⟦candidate.sessionId⟧ · project ⟦candidate.projectIdentity⟧]: "⟦candidate.content⟧"

### Review rules (fixed by Magic Context)

1. Look for **recurring patterns** across multiple candidates — observations that appear independently from different sessions or historian runs indicate a real user trait.
2. A candidate must appear in at least 3 semantically similar variants before promotion.
3. If a candidate is semantically equivalent to an existing stable memory, mark it as already covered.
4. If multiple candidates describe the same trait, merge them into one clean statement.
5. Never promote secrets, credentials, account numbers, or health, financial or relationship details, whatever category a candidate carries.
6. Use only the user categories listed below; never invent a category.

### User categories

- **COMMUNICATION** (global; seen by every profile's agents) — how the user wants agents to talk to them in any work: length, tone, format, reply language, how much to explain.
- **PREFERENCES** (global; seen by every profile's agents) — likes and dislikes the user holds everywhere, including design and visual taste.
- **BOUNDARIES** (global; seen by every profile's agents) — what the user wants to confirm before an agent acts, and what they never want done.
- **WORKING_STYLE** (global; seen by every profile's agents) — how the user works with agents whatever the task: pace, planning, review habits, decision style, feedback.
- **IDENTITY** (global; seen by every profile's agents) — who the user is: name and form of address, time zone, languages, profession and current main focus.
- **ENGINEERING_PRACTICE** (global; seen by only agents running @cortexkit/memory-swe) — how the user does and wants software engineering done in every codebase: debugging, testing, review, delivery, agent workflow.
- **DEV_ENVIRONMENT** (global; seen by only agents running @cortexkit/memory-swe) — the user's own development setup shared by their coding projects: stack, runtimes, package managers, editor, shell, OS.

### Category instructions

1. Only promote traits that hold across the user's work. A preference tied to one project belongs to that project's memory, not here: dismiss it.
2. Put each promoted trait in the one user category whose test it passes. A candidate that mixes a general trait with a domain-specific one is promoted as two memories, one per category.
3. Do NOT promote: one-off moods, task-local frustrations, or anything about other people.
4. Phrase every promoted or updated memory as a concise, present-tense verb-first statement without a subject (for example, "Prefers concise explanations" or "Expects changes to be tested").
5. If an existing stable memory should be updated based on new evidence, include the update and keep the same verb-first, subjectless phrasing and its category.

### Software categories

- `ENGINEERING_PRACTICE` and `DEV_ENVIRONMENT` traits follow the same rules. Framework, language and tool preferences qualify when the candidates come from more than one project; when they all come from one project, dismiss them as project-specific.
- Split a candidate that mixes an engineering practice with a general trait the way the historian does: the general part under its base category, the engineering part under `ENGINEERING_PRACTICE`.

### Output Format

Return valid JSON (no markdown fencing):

{
  "promote": [
    { "content": "Clean universal observation text", "category": "COMMUNICATION", "candidate_ids": [1, 3, 7] }
  ],
  "update_existing": [
    { "memory_id": 5, "content": "Updated text incorporating new evidence", "category": "WORKING_STYLE", "candidate_ids": [2] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "No longer supported by recent observations" }
  ],
  "consume_candidate_ids": [1, 2, 3, 4, 5, 7, 8]
}

- `promote`: new stable memories to create from candidates, each with the tag of one listed user category
- `update_existing`: existing stable memories to rewrite with new evidence (the category may change only to another listed category)
- `dismiss_existing`: existing stable memories that are no longer valid
- `consume_candidate_ids`: ALL candidate IDs that were reviewed (promoted, merged, or rejected) — they will be deleted from the candidate pool

If no promotions are warranted, return empty arrays. Always consume reviewed candidates so they don't accumulate indefinitely.