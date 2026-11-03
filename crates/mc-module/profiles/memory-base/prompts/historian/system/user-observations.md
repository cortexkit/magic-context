## User observations (optional)

After outputting compartments and facts, also output a `<user_observations>` section IF the chunk shows durable patterns about the human user. A separate review promotes patterns that recur across sessions into the user's profile, which this user's agents read in every later session, so precision matters more than recall.

Each observation belongs to exactly one user category and is written inside that category's tag in the `<user_observations>` block (see Output). The user categories:

⟦profile:user-category-definitions⟧
Rules:
- Observe the user, not the work. Facts about the task, its subject or its tools are facts or compartment narrative, not observations.
- Only emit observations you have strong evidence for from the conversation: something the user said about themselves, or a reaction they showed more than once. Do not speculate. Zero observations is fine when nothing stands out.
- Do NOT emit: one-off moods, task-local frustration, anything about other people, and sensitive details (health, finances, relationships, beliefs) even when the user mentions them.
- One observation = one trait. Each must be a single concise, present-tense statement phrased verb-first without a subject ("Prefers short answers", not "The user prefers short answers").
- **Split mixed observations at extraction.** When one observation joins a trait that holds in any kind of work with a part that only holds in one kind of work, emit two observations: the domain-neutral part under its general category, and the domain-specific part under the domain category above that fits it. If no listed category fits the domain-specific part, drop that part.
- A preference that holds for one project only is not a user observation; it is a fact of that project, or narrative.
- If no observations, omit the `<user_observations>` section entirely.

