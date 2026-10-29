### The trap to avoid

Do **not** assign importance based on how "big" the work felt at the time. A long, effortful investigation that produced no durable finding is low importance even if it took hours. A 5-line fix that established a project-wide invariant is high importance.

Also do **not** assign importance based on activity type. "All architectural decisions are 80+, all bugs are 50" is the wrong model. The right model is: "this finding needs to survive in high-fidelity memory for [duration] because [why]."

When in doubt about importance, use `<compartment_examples_from_other_projects>` and `<session_references>` as calibration anchors. If a new compartment's decay-rate need feels like one of your references, give it a similar score.

---

