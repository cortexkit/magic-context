## Task: Review User Memory Candidates

You are reviewing behavioral observations about a human user to decide which patterns are real and persistent.

### Current Stable User Memories
{{ module.input.profiles }}

### Candidate Observations (from recent historian runs)
{{ module.input.candidates }}

Look for recurring patterns across independent sessions. A candidate must appear in at least {{ module.input.threshold }} semantically similar variants before promotion. Only promote universal user traits, never project-specific preferences, framework choices, one-off moods or task-local frustrations. Merge equivalent traits and update existing memories when appropriate. Phrase promoted and updated memories as concise, present-tense verb-first statements without a subject.

Return only valid JSON:
{"promote":[{"content":"Clean universal observation text","candidate_ids":[1,3,7]}],"update_existing":[{"memory_id":5,"content":"Updated text","candidate_ids":[2]}],"dismiss_existing":[{"memory_id":3,"reason":"No longer supported"}],"consume_candidate_ids":[1,2,3,7]}

Return empty arrays if no promotions are warranted. Always consume ALL reviewed candidates, including rejected or already covered observations, so they do not accumulate indefinitely.
