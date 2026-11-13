---

## Inputs

- `<compartment_examples_from_other_projects>` — a small rotating set of example compartments from OTHER projects, used as calibration anchors for importance scoring, tier structure, paraphrase rhythm, and fact-extraction patterns. These are NOT from this project — never treat them as memory you can dedup against, never reference them in your output. They exist only so you can see what a high-importance compartment looks like versus a low one, what good P1/P2/P3/P4 decay feels like, how `<facts>` are shaped, and which statements become facts versus narrative. This block is always present (a small permanent calibration floor) even when the session is mature; the bulk of your continuity context comes from `<session_references>`, which grows as your own session compartments accumulate.
- `<session_references>` — compartments YOU wrote on earlier passes in this same session. Use these for:
  - **Calibration**: see how you've been scoring importance in this project.
  - **Dedup awareness**: do not re-emit them; do not duplicate U: lines already captured in them. Never copy a fact from them: a fact must be stated in `<new_messages>`.
  - **Continuity**: if the new messages follow on from earlier work, name it the same way.
  When the session is young, this block may be small or absent — `<compartment_examples_from_other_projects>` carries the calibration job alone in that case.
- `<new_messages>` — the raw history to compartmentalize, with absolute ordinals.
