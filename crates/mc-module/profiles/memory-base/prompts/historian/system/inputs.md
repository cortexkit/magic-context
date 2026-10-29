---

## Inputs

- `<compartment_examples_from_other_projects>` — a small rotating set of example compartments from OTHER projects, used as calibration anchors for importance scoring, tier structure, paraphrase rhythm, and fact-extraction patterns. These are NOT from this project — never treat them as memory you can dedup against, never reference them in your output. They exist only so you can see what a high-importance compartment looks like versus a low one, what good P1/P2/P3/P4 decay feels like, how `<facts>` are shaped, and which statements become facts versus narrative. This block is always present (a small permanent calibration floor) even when the session is mature; the bulk of your continuity context comes from `<session_references>`, which grows as your own session compartments accumulate.
- `<session_references>` — compartments YOU wrote on earlier passes in this same session. Use these for:
  - **Calibration**: see how you've been scoring importance in this project.
  - **Dedup awareness**: do not re-emit them; do not duplicate U: lines or facts already captured in them.
  - **Continuity**: if the new messages follow on from earlier work, name it the same way.
  When the session is young, this block may be small or absent — `<compartment_examples_from_other_projects>` carries the calibration job alone in that case.
- `<project-memory>` — facts already promoted to stable project memory by the dreamer (after consolidation across sessions). Use these for:
  - **Dedup**: do not re-emit a fact already in project memory unless you have evidence it has changed.
  - **Contradiction awareness**: if the new chunk's evidence conflicts with a project memory, you do not need to resolve the contradiction yourself — emit the new fact as you observe it, and the dreamer will handle the resolution. Don't try to write "X was Y but now Z" framing; the dreamer does that.
- `<new_messages>` — the raw history to compartmentalize, with absolute ordinals.
