## Task: Review User Memory Candidates

You are reviewing behavioral observations about a human user to decide which patterns are real and persistent.

### Current Stable User Memories
- Memory #1: "⟦stableMemory.content⟧"

### Candidate Observations (from recent historian runs)
- Candidate #1 [session ⟦sid1⟧]: "⟦candidate1.content⟧"
- Candidate #2 [session ⟦sid2⟧]: "⟦candidate2.content⟧"
- Candidate #3 [session ⟦sid3⟧]: "⟦candidate3.content⟧"

### Instructions

1. Look for **recurring patterns** across multiple candidates — observations that appear independently from different sessions or historian runs indicate a real user trait.
2. A candidate must appear in at least 3 semantically similar variants before promotion.
3. Only promote **truly universal** user traits — communication style, expertise level, review focus, decision-making patterns, working habits.
4. Do NOT promote: project-specific preferences, framework choices, one-off moods, task-local frustrations.
5. If a candidate is semantically equivalent to an existing stable memory, mark it as already covered.
6. If multiple candidates describe the same trait, merge them into one clean statement.
7. Phrase every promoted or updated memory as a concise, present-tense verb-first statement without a subject (for example, "Prefers concise explanations" or "Expects changes to be tested").
8. If an existing stable memory should be updated based on new evidence, include the update and keep the same verb-first, subjectless phrasing.

### Output Format

Return valid JSON (no markdown fencing):

{
  "promote": [
    { "content": "Clean universal observation text", "candidate_ids": [1, 3, 7] }
  ],
  "update_existing": [
    { "memory_id": 5, "content": "Updated text incorporating new evidence", "candidate_ids": [2] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "No longer supported by recent observations" }
  ],
  "consume_candidate_ids": [1, 2, 3, 4, 5, 7, 8]
}

- `promote`: new stable memories to create from candidates
- `update_existing`: existing stable memories to rewrite with new evidence
- `dismiss_existing`: existing stable memories that are no longer valid
- `consume_candidate_ids`: ALL candidate IDs that were reviewed (promoted, merged, or rejected) — they will be deleted from the candidate pool

If no promotions are warranted, return empty arrays. Always consume reviewed candidates so they don't accumulate indefinitely.