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
