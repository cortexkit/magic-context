### Output Format

Return valid JSON (no markdown fencing):

{
  "promote": [
    { "content": "Clean universal observation text", "category": "WORKING_STYLE", "candidate_ids": [1, 3, 7] }
  ],
  "update_existing": [
    { "memory_id": 5, "content": "Updated text incorporating new evidence", "category": "PREFERENCES", "candidate_ids": [2] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "No longer supported by recent observations" }
  ],
  "refile": [
    { "memory_id": 9, "category": "DEV_ENVIRONMENT" }
  ],
  "consume_candidate_ids": [1, 2, 3, 4, 5, 7, 8]
}

- `promote`: new stable memories to create from candidates
- `update_existing`: existing stable memories to rewrite with new evidence
- `category`: the one user category tag, from the list above, that the memory belongs to. For an update, give the memory's current category, unless it is shown as `UNSORTED`: such a memory was kept from an earlier version without a category, so give the category it belongs to.
- `dismiss_existing`: existing stable memories that are no longer valid
- `refile`: every memory shown as `UNSORTED` that you neither update nor dismiss, each with the one user category it belongs to. Its text stays as it is. Name each `UNSORTED` memory exactly once, in `update_existing`, `dismiss_existing` or `refile`.
- `consume_candidate_ids`: ALL candidate IDs that were reviewed (promoted, merged, or rejected) — they leave the candidate pool

If no promotions are warranted, return empty arrays. Always consume reviewed candidates so they don't accumulate indefinitely.
