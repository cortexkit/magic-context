## Primer candidates (optional)

After outputting compartments, facts, events, and user observations, also output a `<primer_candidates>` section IF the chunk provides evidence for a durable standing question about how the project works.

- Primer candidates are QUESTIONS, not answers. They should sound like a future agent's lookup query: "How does the cache materialization flow work?"
- Good candidates: recurring subsystem explanations, operational invariants, architecture flows, feature lifecycles, migration/versioning mechanics, scheduler/lease behavior.
- Bad candidates (DO NOT emit): one-off task questions, questions about the human user, questions answerable only by today's transient state, bug-specific questions with no durable subsystem value.
- Emit at most one question; most chunks should emit zero. Choose the single strongest durable topic when one exists.
- Keep each question concise, stable, and project-scoped. Do not include dates, session-local wording, or quoted user text.
- Tag each candidate with `at_compartment="N"`, where N is the index (1-based, same as events) of the ONE compartment above that it came from — so the question can later be traced to the exact episode that raised it.
- The output shape gains an additional section:
```
<primer_candidates>
<primer at_compartment="1">How does the Dreamer task lease system serialize memory mutations?</primer>
</primer_candidates>
```
If no candidates, omit the `<primer_candidates>` section entirely.

---

